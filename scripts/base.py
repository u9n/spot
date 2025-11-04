from __future__ import annotations

import json
import zoneinfo
from datetime import datetime, date
from typing import Union

import attr
from cattrs import GenConverter
from cattrs.gen import make_dict_structure_fn, override


PRICE_AREA_CODES = {
    "SE1": "10Y1001A1001A44P",  # Sweden
    "SE2": "10Y1001A1001A45N",
    "SE3": "10Y1001A1001A46L",
    "SE4": "10Y1001A1001A47J",
    "DK1": "10YDK-1--------W",  # Denmark
    "DK2": "10YDK-2--------M",
    "NO1": "10YNO-1--------2",  # Norway
    "NO2": "10YNO-2--------T",
    "NO3": "10YNO-3--------J",
    "NO4": "10YNO-4--------9",
    "NO5": "10Y1001A1001A48H",
    "FI": "10YFI-1--------U",  # Finland
    "DE_LU": "10Y1001A1001A82H",  # Germany / Luxembourg
    "AT": "10YAT-APG------L",  # Austria
    "FR": "10YFR-RTE------C",  # France
    "BE": "10YBE----------2",  # Belgium
    "NL": "10YNL----------L",  # Netherlands
    "PL": "10YPL-AREA-----S",  # Poland
    "EE": "10Y1001A1001A39I",  # Estonia
    "LT": "10YLT-1001A0008Q",  # Lithuania
    "LV": "10YLV-1001A00074",  # Latvia
    "IT-NORTH": "10Y1001A1001A73I",  # Italy
    "IT-CENTRE_NORTH": "10Y1001A1001A70O",
    "IT-CENTRE_SOUTH": "10Y1001A1001A71M",
    "IT-SOUTH": "10Y1001A1001A788",
    "IT-SICILY": "10Y1001A1001A75E",
    "IT-SARDINIA": "10Y1001A1001A74G",
    "IT-CALABRIA": "10Y1001C--00096J",
    "CH": "10YCH-SWISSGRIDZ",  # Switzerland
    "ES": "10YES-REE------0",  # Spain
    "PT": "10YPT-REN------W",  # Portugal
    "SK": "10YSK-SEPS-----K",  # Slovakia
    "SI": "10YSI-ELES-----O",  # Slovenia
    "CZ": "10YCZ-CEPS-----N",  # Czech Republic
    "HU": "10YHU-MAVIR----U",  # Hungary
    "HR": "10YHR-HEP------M",  # Croatia
    "RO": "10YRO-TEL------P",  # Romania
    "RS": "10YCS-SERBIATSOV",  # Serbia
    "BG": "10YCA-BULGARIA-R",  # Bulgaria
    "GR": "10YGR-HTSO-----Y",  # Greece
}

PRICE_AREAS = set(PRICE_AREA_CODES.keys())

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
