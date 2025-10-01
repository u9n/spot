from __future__ import annotations

import json
import zoneinfo
from datetime import datetime, date
from typing import Union

import attr
from cattrs import GenConverter
from cattrs.gen import make_dict_structure_fn, override


PRICE_AREAS = {"SE1", "SE2", "SE3", "SE4"}

BASE_DIRECTORY = "docs/electricity"

@attr.s(auto_attribs=True, frozen=True)
class Price:
    timestamp: datetime
    value: str



def structure_datetime(date_string: str, cls: Type):
    dt = datetime.fromisoformat(date_string)
    return dt.replace(tzinfo=zoneinfo.ZoneInfo("Etc/GMT-1"))


from_api_converter = GenConverter()
from_api_converter.register_structure_hook(datetime, structure_datetime)
from_api_converter.register_structure_hook(Price,
                                           make_dict_structure_fn(Price,
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
file_converter.register_structure_hook(
    date, lambda ts, _: date.fromisoformat(ts)
)
file_converter.register_unstructure_hook(date, lambda dt: dt.isoformat())


def get_saved_prices_for_day(date_string: str, price_area: str) -> list[Price]:
    year, month, day = date_string.split("-")
    try:
        with open(f"{BASE_DIRECTORY}/{price_area}/{year}/{month}/{day}/index.json", "r") as file:
            out = list()
            data = json.load(file)
            for item in data:
                out.append(file_converter.structure(item, Price))

            return out

    except FileNotFoundError:
        return list()


def get_saved_prices_for_month(month_string: str, price_area: str) -> list[Price]:
    year, month = month_string.split("-")
    try:
        with open(f"{BASE_DIRECTORY}/{price_area}/{year}/{month}/index.json", "r") as file:
            out = list()
            data = json.load(file)
            for item in data:
                out.append(file_converter.structure(item, Price))

            return out

    except FileNotFoundError:
        return list()


def get_saved_prices_for_year(year_string: str, price_area: str) -> list[Price]:
    try:
        with open(f"{BASE_DIRECTORY}/{price_area}/{year_string}/index.json", "r") as file:
            out = list()
            data = json.load(file)
            for item in data:
                out.append(file_converter.structure(item, Price))

            return out

    except FileNotFoundError:
        return list()