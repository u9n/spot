import json
import time
from collections import deque
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import threading
import attr
import httpx
import xmltodict
from typing import *
from dateutil.parser import parse as dt_parse
import click
from cattrs import GenConverter, transform_error
from cattrs.gen import make_dict_structure_fn, override
import structlog

LOG = structlog.get_logger()


class RateLimiter:
    """Simple thread-safe rate limiter for synchronous contexts."""

    def __init__(self, max_calls: int, period: float):
        self.max_calls = max_calls
        self.period = period
        self._timestamps: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self):
        while True:
            with self._lock:
                now = time.monotonic()
                cutoff = now - self.period
                while self._timestamps and self._timestamps[0] <= cutoff:
                    self._timestamps.popleft()

                if len(self._timestamps) < self.max_calls:
                    self._timestamps.append(now)
                    return

                sleep_for = self._timestamps[0] + self.period - now

            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                time.sleep(0)

from base import (
    Price,
    get_saved_prices_for_year,
    get_saved_prices_for_month,
    get_saved_prices_for_day,
)
from get_spot_prices import (
    group_values_by_year,
    save_year_to_file,
    group_values_by_month,
    save_month_to_file,
    group_values_by_day,
    save_day_to_file,
    save_latest_prices,
)

LOG = structlog.get_logger()

REQUEST_RATE_LIMITER = RateLimiter(max_calls=295, period=60.0)


@attr.s(auto_attribs=True, frozen=True)
class DataPoint:
    position: int
    price: Decimal


@attr.s(auto_attribs=True, frozen=True)
class TimeInterval:
    start: datetime
    end: datetime


@attr.s(auto_attribs=True, frozen=True)
class Period:
    interval: TimeInterval
    resolution: str
    data_points: list[DataPoint]


@attr.s(auto_attribs=True, frozen=True)
class TimeSeries:
    currency: str
    energy_unit: str
    period: Period
    classification_position: Optional[int] = None

    def quarterly_data(self):
        out = []
        quarterly_pointer = 1
        for point in self.period.data_points:
            if quarterly_pointer == point.position:
                # We have a price for this point
                timestamp = self.period.interval.start + timedelta(minutes=(15 * (point.position-1)))
                quarterly_pointer += 1
                price = Price(timestamp, str(point.price))
                out.append(price)
            else:
                while quarterly_pointer <= point.position:
                    timestamp = self.period.interval.start + timedelta(minutes=(15 * (quarterly_pointer-1)))
                    quarterly_pointer += 1
                    value_to_use = out[-1].value if out else str(point.price)
                    price = Price(timestamp, value_to_use)
                    out.append(price)

        if quarterly_pointer != 96:
            # We are missing some prices on the end:
            while quarterly_pointer <= 96:
                timestamp = self.period.interval.start + timedelta(minutes=(15 * (quarterly_pointer-1)))
                quarterly_pointer += 1
                value_to_use = out[-1].value if out else str(point.price)
                price = Price(timestamp, value_to_use)
                out.append(price)

        return out


    def hourly_data(self):
        out = []
        hourly_pointer = 1
        for point in self.period.data_points:
            if hourly_pointer == point.position:
                timestamp = self.period.interval.start + timedelta(hours=point.position - 1)
                hourly_pointer += 1
                price = Price(timestamp, str(point.price))
                out.append(price)
            else:
                while hourly_pointer <= point.position:
                    timestamp = self.period.interval.start + timedelta(hours=hourly_pointer - 1)
                    hourly_pointer += 1
                    value_to_use = out[-1].value if out else str(point.price)
                    price = Price(timestamp, value_to_use)
                    out.append(price)
        if hourly_pointer != 24:
            # We are missing some prices on the end:
            while hourly_pointer <= 24:
                timestamp = self.period.interval.start + timedelta(hours=hourly_pointer - 1)
                hourly_pointer += 1
                value_to_use = out[-1].value if out else str(point.price)
                price = Price(timestamp, value_to_use)
                out.append(price)

        return out

    @property
    def data(self):
        if self.period.resolution == "PT60M":  # hourly
            return self.hourly_data()
        elif self.period.resolution == "PT15M":
            return self.quarterly_data()
        else:
            raise ValueError(f"Invalid period resolution, {self.period.resolution}")
    


def structure_resultion(resolution_string: str, klass: Type) -> int:
    resultion_map: dict[str, int] = {"PT60M": 60}
    return resultion_map[resolution_string]


from_api_converter = GenConverter()
# from_api_converter.register_structure_hook(datetime, structure_datetime)
from_api_converter.register_structure_hook(datetime, lambda ts, _: dt_parse(ts))
from_api_converter.register_structure_hook(Decimal, lambda x, _: Decimal(x))
from_api_converter.register_structure_hook(
    DataPoint,
    make_dict_structure_fn(
        DataPoint,
        from_api_converter,
        price=override(rename="price.amount"),
    ),
)
from_api_converter.register_structure_hook(
    Period,
    make_dict_structure_fn(
        Period,
        from_api_converter,
        data_points=override(rename="Point"),
        interval=override(rename="timeInterval"),
    ),
)
from_api_converter.register_structure_hook(
    TimeSeries,
    make_dict_structure_fn(
        TimeSeries,
        from_api_converter,
        currency=override(rename="currency_Unit.name"),
        energy_unit=override(rename="price_Measure_Unit.name"),
        period=override(rename="Period"),
        classification_position=override(
            rename="classificationSequence_AttributeInstanceComponent.position"
        ),
    ),
)

price_area_map: dict[str, str] = {
    "SE1": "10Y1001A1001A44P",  # Sweden
    "SE2": "10Y1001A1001A45N",  # Sweden
    "SE3": "10Y1001A1001A46L",  # Sweden
    "SE4": "10Y1001A1001A47J",  # Sweden
    "DK1": "10YDK-1--------W",  # Denmark
    "DK2": "10YDK-2--------M",  # Denmark
    "NO1": "10YNO-1--------2",  # Norway
    "NO2": "10YNO-2--------T",  # Norway
    "NO3": "10YNO-3--------J",  # Norway
    "NO4": "10YNO-4--------9",  # Norway
    "NO5": "10Y1001A1001A48H",  # Norway
    "FI": "10YFI-1--------U",  # Finland
    "DE_LU": "10Y1001A1001A82H",  # Germany
    "AT": "10YAT-APG------L",  # Austria
    "FR": "10YFR-RTE------C",  # France
    "BE": "10YBE----------2",  # Belgium
    "NL": "10YNL----------L",  # Netherlands
    "PL": "10YPL-AREA-----S",  # Poland
    "EE": "10Y1001A1001A39I",  # Estonia
    "LT": "10YLT-1001A0008Q",  # Lithuania
    "LV": "10YLV-1001A00074",  # Latvia
    "IT-NORTH": "10Y1001A1001A73I",  # Italy
    "IT-CENTRE_NORTH": "10Y1001A1001A70O",  # Italy
    "IT-CENTRE_SOUTH": "10Y1001A1001A71M",  # Italy
    "IT-SOUTH": "10Y1001A1001A788",  # Italy
    "IT-SICILY": "10Y1001A1001A75E",  # Italy
    "IT-SARDINIA": "10Y1001A1001A74G",  # Italy
    "IT-CALABRIA": "10Y1001C--00096J",  # Italy
    "CH": "10YCH-SWISSGRIDZ",  # Switzerland
    "ES": "10YES-REE------0",  # Spain
    "PT": "10YPT-REN------W",  # Portugal
    "SK": "10YSK-SEPS-----K",  # Slovakia
    "SI": "10YSI-ELES-----O",  # Slovenia
    "CZ": "10YCZ-CEPS-----N",  # Czech Republic
    "HU": "10YHU-MAVIR----U",  # Hungary
    "HR": "10YHR-HEP------M",  # Croatia
    "RO": "10YRO-TEL------P",  # Romania
    "RS": "10YCS-SERBIATSOV",   # Serbia
    "BG": "10YCA-BULGARIA-R",  # Bulgaria
    "GR": "10YGR-HTSO-----Y",  # Greece
    "SEM": "10Y1001A1001A59C",  # Ireland (Single Electricity Market)  old data has 30 min values.



}


def update_yearly(prices: list[Price], price_area: str):
    grouped = group_values_by_year(prices)
    for year in grouped.keys():
        LOG.info("Updating yearly values", year=year, area=price_area)
        saved_prices = get_saved_prices_for_year(year, price_area)
        merged_prices = set()
        for price in saved_prices:
            merged_prices.add(price)
        for price in grouped[year]:
            merged_prices.add(price)

        save_year_to_file(year, list(merged_prices), price_area)


def update_monthly(prices: list[Price], price_area: str):
    grouped = group_values_by_month(prices)
    for month in grouped.keys():
        LOG.info("Updating monthly values", month=month, area=price_area)
        saved_prices = get_saved_prices_for_month(month, price_area)
        merged_prices = set()
        for price in saved_prices:
            merged_prices.add(price)
        for price in grouped[month]:
            merged_prices.add(price)

        save_month_to_file(month, list(merged_prices), price_area)


def update_daily(prices: list[Price], price_area: str):
    grouped = group_values_by_day(prices)
    for day in grouped.keys():
        LOG.info("Updating daily values", day=day, area=price_area)
        saved_prices = get_saved_prices_for_day(day, price_area)
        merged_prices = set()
        for price in saved_prices:
            merged_prices.add(price)
        for price in grouped[day]:
            merged_prices.add(price)

        save_day_to_file(day, list(merged_prices), price_area)


def update_latest(prices: list[Price], price_area: str):
    LOG.info("Updating latest values", price_area=price_area)
    today = datetime.now(tz=timezone.utc).date()
    tomorrow = today + timedelta(days=1)
    latest_prices = list()
    grouped = group_values_by_day(prices)
    try:
        latest_prices.extend(grouped[today.strftime("%Y-%m-%d")])
        latest_prices.extend(grouped[tomorrow.strftime("%Y-%m-%d")])
    except KeyError:
        # Before they are pubished we wont get the data
        pass
    save_latest_prices(latest_prices, price_area)


def get_prices(start: datetime, end: datetime, price_area: str, security_token: str):
    base_url = "https://web-api.tp.entsoe.eu/api"
    area_code = price_area_map[price_area]

    LOG.info(
        "Reading values", url=base_url, start=start, end=end, area_code=area_code
    )
    params = {
        "securityToken": security_token,
        "periodStart": start.strftime("%Y%m%d%H00"),
        "periodEnd": end.strftime("%Y%m%d%H00"),
        "documentType": "A44",
        "in_Domain": area_code,
        "out_Domain": area_code,
    }

    REQUEST_RATE_LIMITER.acquire()
    response = httpx.get(base_url, params=params, timeout=120)
    LOG.info(
        "Received response",
        status_code=response.status_code,
        length=len(response.content),
        content=response.content,
    )
    try:
        timeseries_node = xmltodict.parse(response.text)["Publication_MarketDocument"][
            "TimeSeries"
        ]
    except KeyError:
        LOG.error("Problem with content of response", content=response.content)
        return

    if isinstance(timeseries_node, dict):
        timeseries_iterable = [timeseries_node]
    else:
        timeseries_iterable = timeseries_node

    aggregated: dict[datetime, tuple[Price, int]] = {}

    for series in timeseries_iterable:
        try:
            ts = from_api_converter.structure(series, TimeSeries)
        except Exception as exc:
            LOG.error(
                "Failed to structure time series",
                error=transform_error(exc),
                raw_series=series,
            )
            continue

        classification_raw = ts.classification_position
        try:
            classification = int(classification_raw) if classification_raw is not None else 999
        except (TypeError, ValueError):
            LOG.warning(
                "Unexpected classification value; treating as provisional",
                value=classification_raw,
            )
            classification = 999

        LOG.info(
            "Handling time series",
            price_area=price_area,
            resolution=ts.period.resolution,
            classification_position=ts.classification_position,
        )
        for price_point in ts.data:
            existing = aggregated.get(price_point.timestamp)
            if existing is None or classification < existing[1]:
                aggregated[price_point.timestamp] = (price_point, classification)

    normalized_prices = [value[0] for _, value in sorted(aggregated.items())]

    return normalized_prices


def _backfill_price_area(
    start_dt: datetime, end_dt: datetime, price_area: str, security_token: str
):
    current_point = start_dt

    while current_point < end_dt:
        step_end = min(current_point + timedelta(days=14), end_dt)
        prices = get_prices(current_point, step_end, price_area, security_token)
        if prices is None:
            LOG.warning(
                "No prices returned; skipping update",
                price_area=price_area,
                start=current_point,
                end=step_end,
            )
            current_point = step_end
            continue
        update_yearly(prices, price_area)
        update_monthly(prices, price_area)
        update_daily(prices, price_area)
        current_point = step_end


def _get_day_ahead_prices_for_price_area(
    start: datetime, end: datetime, price_area: str, security_token: str
):
    prices = get_prices(start, end, price_area, security_token)
    if prices is None:
        LOG.warning(
            "No prices returned; skipping price updates",
            price_area=price_area,
            start=start,
            end=end,
        )
        return
    update_yearly(prices, price_area)
    update_monthly(prices, price_area)
    update_daily(prices, price_area)
    update_latest(prices, price_area)


@click.group()
def cli():
    pass


@click.command()
@click.option("--start", help="Start date in UTC", type=str, required=True)
@click.option(
    "--end",
    help="End date in UTC",
    type=str,
)
@click.option(
    "--price-area",
    required=False,
    help="Name of price area",
    type=click.Choice(price_area_map.keys()),
)
@click.option(
    "--security-token", envvar="TRANSPARENCY_PLATFORM_SECURITY_TOKEN", type=str
)
@click.option(
    "--all-bidding-zones",
    is_flag=True,
    default=False,
    help="Backfill every bidding zone defined in the script",
)
def backfill(
    start: str,
    end: str,
    price_area: str,
    security_token: str,
    all_bidding_zones: bool,
):
    start_dt = dt_parse(start)
    end_dt = dt_parse(end)

    if all_bidding_zones and price_area:
        raise click.UsageError("Use --price-area or --all-bidding-zones, not both.")
    if not all_bidding_zones and not price_area:
        raise click.UsageError("Provide --price-area or use --all-bidding-zones.")

    zones = list(price_area_map.keys()) if all_bidding_zones else [price_area]

    for zone in zones:
        LOG.info("Starting backfill", price_area=zone, start=start_dt, end=end_dt)
        _backfill_price_area(start_dt, end_dt, zone, security_token)
        LOG.info("Finished backfill", price_area=zone, start=start_dt, end=end_dt)


@click.command()
@click.option(
    "--days-ahead",
    default=2,
    help="Number of days to fetch ahead of todays date",
    type=int,
)
@click.option(
    "--days-behind",
    default=4,
    help="Number of days to fetch beehind todays date",
    type=int,
)
@click.option(
    "--price-area",
    required=False,
    help="Name of price area",
    type=click.Choice(price_area_map.keys()),
)
@click.option(
    "--security-token", envvar="TRANSPARENCY_PLATFORM_SECURITY_TOKEN", type=str
)
@click.option(
    "--all-bidding-zones",
    is_flag=True,
    default=False,
    help="Fetch day-ahead prices for every bidding zone defined in the script",
)
def get_day_ahead_prices(
        days_ahead: int,
        days_behind: int,
        price_area: str,
        security_token: str,
        all_bidding_zones: bool,
):
    if all_bidding_zones and price_area:
        raise click.UsageError("Use --price-area or --all-bidding-zones, not both.")
    if not all_bidding_zones and not price_area:
        raise click.UsageError("Provide --price-area or use --all-bidding-zones.")

    zones = list(price_area_map.keys()) if all_bidding_zones else [price_area]
    now = datetime.now(tz=timezone.utc)
    start = now - timedelta(days=days_behind)
    end = now + timedelta(days=days_ahead)

    for zone in zones:
        LOG.info(
            "Fetching day-ahead prices",
            price_area=zone,
            start=start,
            end=end,
        )
        _get_day_ahead_prices_for_price_area(start, end, zone, security_token)


cli.add_command(backfill)
cli.add_command(get_day_ahead_prices)

if __name__ == "__main__":
    cli()
