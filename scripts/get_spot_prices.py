from __future__ import annotations

import json
from typing import Type

import cattr
import attr
from datetime import datetime
import httpx
import zoneinfo
from cattrs import GenConverter
from cattrs.gen import make_dict_structure_fn, override


@attr.s(auto_attribs=True, frozen=True)
class HourlyPrice:
    timestamp: datetime
    value: str


PRICE_AREAS = {"SE1", "SE2", "SE3", "SE4"}

SPOT_BASE_URL = ""

URL = "https://www.vattenfall.se/api/price/spot/pricearea/2022-08-27/2022-09-02/SN4"


def url_of_price_area(price_area: str) -> str:
    area_map = {
        "SE1": "SN1",
        "SE2": "SN2",
        "SE3": "SN3",
        "SE4": "SN4",
    }
    return f"https://www.vattenfall.se/api/price/spot/pricearea/2022-08-27/2022-09-02/{area_map[price_area]}"


def structure_datetime(date_string: str, cls: Type):
    dt = datetime.fromisoformat(date_string)
    return dt.replace(tzinfo=zoneinfo.ZoneInfo("ETC/GMT-1"))


from_api_converter = GenConverter()
from_api_converter.register_structure_hook(datetime, structure_datetime)
from_api_converter.register_structure_hook(
    HourlyPrice,
    make_dict_structure_fn(
        HourlyPrice,
        from_api_converter,
        timestamp=override(rename="TimeStamp"),
        value=override(rename="Value"),
    ),
)

file_converter = GenConverter()
file_converter.register_structure_hook(
    datetime, lambda ts, _: datetime.fromisoformat(ts)
)
file_converter.register_unstructure_hook(datetime, lambda dt: dt.isoformat())


def save_day_to_file(
    day_string: str, hourly_prices: list[HourlyPrice], price_area: str
):
    output = list()
    for price in hourly_prices:
        output.append(file_converter.unstructure(price))

    with open(f"./site/data/{price_area}/{day_string}.json", "w") as file:
        json.dump(output, file)


def group_hourly_values_by(
    hourly_prices: list[HourlyPrice],
) -> dict[str, list[HourlyPrice]]:
    out = dict()
    for price in hourly_prices:
        try:
            out[price.timestamp.strftime("%Y-%m-%d")].append(price)
        except KeyError:
            out[price.timestamp.strftime("%Y-%m-%d")] = list()
            out[price.timestamp.strftime("%Y-%m-%d")].append(price)
    return out


def get_saved_prices_for_day(day_string: str, price_area: str) -> list[HourlyPrice]:
    try:
        with open(f"./data/{price_area}/{day_string}.json", "r") as file:
            out = list()
            data = json.load(file)
            for item in data:
                out.append(file_converter.structure(item, HourlyPrice))

            return out

    except FileNotFoundError:
        return list()


def merge_prices(
    saved_prices: list[HourlyPrice], prices_from_api: list[HourlyPrice]
) -> list[HourlyPrice]:
    out = set(saved_prices)
    for price in prices_from_api:
        out.add(price)
    return list(out)


def get_latest_price_area_data(price_area: str) -> list[HourlyPrice]:
    response = httpx.get(url_of_price_area(price_area))
    data = response.json()

    hourly_prices = list()
    for item in data:
        hourly_prices.append(from_api_converter.structure(item, HourlyPrice))

    return hourly_prices


if __name__ == "__main__":
    for area in PRICE_AREAS:
        hourly_prices = get_latest_price_area_data(area)
        grouped_prices = group_hourly_values_by(hourly_prices)

        for day in grouped_prices.keys():
            saved_prices = get_saved_prices_for_day(day, area)
            merged_prices = merge_prices(saved_prices, grouped_prices[day])
            save_day_to_file(day, merged_prices, area)
