import json
import pprint
import time
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import attr
import httpx
import structlog
import xmltodict
from typing import *
from dateutil.parser import parse as dt_parse
import click
from cattrs import GenConverter, transform_error
from cattrs.gen import make_dict_structure_fn, override
import structlog

LOG = structlog.get_logger()

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
                    price = Price(timestamp, str(point.price))
                    out.append(price)

        if quarterly_pointer != 96:
            # We are missing some prices on the end:
            while quarterly_pointer <= 96:
                timestamp = self.period.interval.start + timedelta(minutes=(15 * (quarterly_pointer-1)))
                quarterly_pointer += 1
                price = Price(timestamp, str(point.price))
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
                    price = Price(timestamp, str(point.price))
                    out.append(price)
        if hourly_pointer != 24:
            # We are missing some prices on the end:
            while hourly_pointer <= 24:
                timestamp = self.period.interval.start + timedelta(hours=hourly_pointer - 1)
                hourly_pointer += 1
                price = Price(timestamp, str(point.price))
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
    ),
)

price_area_map: dict[str, str] = {
    "SE1": "10Y1001A1001A44P",
    "SE2": "10Y1001A1001A45N",
    "SE3": "10Y1001A1001A46L",
    "SE4": "10Y1001A1001A47J",
    "DK1": "10YDK-1--------W",
    "DK2": "10YDK-2--------M",
    "NO1": "10YNO-1--------2",
    "NO2": "10YNO-2--------T",
    "NO3": "10YNO-3--------J",
    "NO4": "10YNO-4--------9",
    "NO5": "10Y1001A1001A48H",
    "FI": "10YFI-1--------U"
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

    response = httpx.get(base_url, params=params, timeout=120)
    LOG.info(
        "Received response",
        status_code=response.status_code,
        length=len(response.content),
        content=response.content,
    )
    timeseries = None
    try:
        timeseries = xmltodict.parse(response.text)["Publication_MarketDocument"][
            "TimeSeries"
        ]
        LOG.info("Received timeseries", timeseries=timeseries)
    except KeyError:
        LOG.error("Problem with content of response", content=response.content)
        return

    prices = []

    try:
        for series in timeseries:
            ts = from_api_converter.structure(series, TimeSeries)
            LOG.info("Handling time series", timeseries=ts)
            resolution = ts.period.resolution
            prices.extend(ts.data)

    except Exception as exc:
        print(transform_error(exc))

    return prices


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
    required=True,
    help="Name of price area",
    type=click.Choice(price_area_map.keys()),
)
@click.option(
    "--security-token", envvar="TRANSPARENCY_PLATFORM_SECURITY_TOKEN", type=str
)
def backfill(start: str, end: str, price_area: str, security_token: str):
    start_dt = dt_parse(start)
    end_dt = dt_parse(end)

    current_point = start_dt

    while current_point < end_dt:
        step_end = current_point + timedelta(days=14)
        prices = get_prices(current_point, step_end, price_area, security_token)
        update_yearly(prices, price_area)
        update_monthly(prices, price_area)
        update_daily(prices, price_area)
        current_point = step_end
        time.sleep(1)


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
    required=True,
    help="Name of price area",
    type=click.Choice(["SE1", "SE2", "SE3", "SE4"]),
)
@click.option(
    "--security-token", envvar="TRANSPARENCY_PLATFORM_SECURITY_TOKEN", type=str
)
def get_day_ahead_prices(
        days_ahead: int, days_behind: int, price_area: str, security_token: str
):
    now = datetime.now(tz=timezone.utc)
    start = now - timedelta(days=days_behind)
    end = now + timedelta(days=days_ahead)
    prices = get_prices(start, end, price_area, security_token)
    update_yearly(prices, price_area)
    update_monthly(prices, price_area)
    update_daily(prices, price_area)
    update_latest(prices, price_area)


cli.add_command(backfill)
cli.add_command(get_day_ahead_prices)

if __name__ == "__main__":
    cli()
