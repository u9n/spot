from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, date
import httpx
import zoneinfo

from base import (HourlyPrice, file_converter, from_api_converter,
                   get_saved_prices_for_day, get_saved_prices_for_month,
                   get_saved_prices_for_year, BASE_DIRECTORY, )


def url_of_price_area(price_area: str, from_date: date, to_date: date) -> str:
    area_map = {
        "SE1": "SN1",
        "SE2": "SN2",
        "SE3": "SN3",
        "SE4": "SN4",
    }
    return f"https://www.vattenfall.se/api/price/spot/pricearea/{from_date.strftime('%Y-%m-%d')}/{to_date.strftime('%Y-%m-%d')}/{area_map[price_area]}"


def save_day_to_file(
    day_string: str, hourly_prices: list[HourlyPrice], price_area: str
):
    year, month, day = day_string.split("-")
    output = list()
    for price in hourly_prices:
        output.append(file_converter.unstructure(price))
    try:
        os.makedirs(f"{BASE_DIRECTORY}/{price_area}/{year}/{month}/{day}")
    except OSError:
        # folders exists
        pass
    with open(
        f"{BASE_DIRECTORY}/{price_area}/{year}/{month}/{day}/index.json", "w"
    ) as file:
        json.dump(output, file)


def save_month_to_file(
    month_string: str, hourly_prices: list[HourlyPrice], price_area: str
):
    year, month = month_string.split("-")
    output = list()
    for price in hourly_prices:
        output.append(file_converter.unstructure(price))
    try:
        os.makedirs(f"{BASE_DIRECTORY}/{price_area}/{year}/{month}")
    except OSError:
        # folders exists
        pass
    with open(f"{BASE_DIRECTORY}/{price_area}/{year}/{month}/index.json", "w") as file:
        json.dump(output, file)


def save_year_to_file(
    year_string: str, hourly_prices: list[HourlyPrice], price_area: str
):
    output = list()
    for price in hourly_prices:
        output.append(file_converter.unstructure(price))
    try:
        os.makedirs(f"{BASE_DIRECTORY}/{price_area}/{year_string}")
    except OSError:
        # folders exists
        pass
    with open(f"{BASE_DIRECTORY}/{price_area}/{year_string}/index.json", "w") as file:
        json.dump(output, file)


def group_hourly_values_by_day(
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


def group_hourly_values_by_month(
    hourly_prices: list[HourlyPrice],
) -> dict[str, list[HourlyPrice]]:
    out = dict()
    for price in hourly_prices:
        try:
            out[price.timestamp.strftime("%Y-%m")].append(price)
        except KeyError:
            out[price.timestamp.strftime("%Y-%m")] = list()
            out[price.timestamp.strftime("%Y-%m")].append(price)
    return out


def group_hourly_values_by_year(
    hourly_prices: list[HourlyPrice],
) -> dict[str, list[HourlyPrice]]:
    out = dict()
    for price in hourly_prices:
        try:
            out[price.timestamp.strftime("%Y")].append(price)
        except KeyError:
            out[price.timestamp.strftime("%Y")] = list()
            out[price.timestamp.strftime("%Y")].append(price)
    return out


def merge_prices(
    saved_prices: list[HourlyPrice], prices_from_api: list[HourlyPrice]
) -> list[HourlyPrice]:
    out = set(saved_prices)
    for price in prices_from_api:
        out.add(price)
    return list(out)


def get_latest_price_area_data(
    price_area: str, days_back: int, days_ahead: int
) -> list[HourlyPrice]:
    today = datetime.now(tz=zoneinfo.ZoneInfo("Etc/GMT-1")).date()
    from_date = today - timedelta(days=days_back)
    to_date = today + timedelta(days=days_ahead)
    url = url_of_price_area(price_area, from_date, to_date)

    response = httpx.get(url, timeout=20)
    data = response.json()

    hourly_prices = list()
    for item in data:
        hourly_prices.append(from_api_converter.structure(item, HourlyPrice))

    return hourly_prices


def save_latest_prices(latest_prices: list[HourlyPrice], price_area: str):
    output = list()
    for price in latest_prices:
        output.append(file_converter.unstructure(price))
    try:
        os.makedirs(f"{BASE_DIRECTORY}/{price_area}/latest")
    except OSError:
        # folders exists
        pass
    with open(f"{BASE_DIRECTORY}/{price_area}/latest/index.json", "w") as file:
        json.dump(output, file)


if __name__ == "__main__":
    for area in PRICE_AREAS:
        hourly_prices = get_latest_price_area_data(area, 4, 1)
        grouped_prices_by_day = group_hourly_values_by_day(hourly_prices)
        grouped_prices_by_month = group_hourly_values_by_month(hourly_prices)
        grouped_prices_by_year = group_hourly_values_by_year(hourly_prices)

        for day in grouped_prices_by_day.keys():
            saved_prices = get_saved_prices_for_day(day, area)
            merged_prices = merge_prices(saved_prices, grouped_prices_by_day[day])
            save_day_to_file(day, merged_prices, area)

        for month in grouped_prices_by_month.keys():
            saved_prices = get_saved_prices_for_month(month, area)
            merged_prices = merge_prices(saved_prices, grouped_prices_by_month[month])
            save_month_to_file(month, merged_prices, area)

        for year in grouped_prices_by_year.keys():
            saved_prices = get_saved_prices_for_year(year, area)
            merged_prices = merge_prices(saved_prices, grouped_prices_by_year[year])
            save_year_to_file(year, merged_prices, area)

        today = datetime.now(tz=zoneinfo.ZoneInfo("Etc/GMT-1")).date()
        tomorrow = today + timedelta(days=1)
        latest_prices = list()
        latest_prices.extend(grouped_prices_by_day[today.strftime("%Y-%m-%d")])
        try:
            latest_prices.extend(grouped_prices_by_day[tomorrow.strftime("%Y-%m-%d")])
        except KeyError:
            # Before they are pubished we wont get the data
            pass
        save_latest_prices(latest_prices, area)
