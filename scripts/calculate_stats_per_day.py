import os
from datetime import date, timedelta
import json
from statistics import mean
import structlog
import attr

from base import get_saved_prices_for_day, BASE_DIRECTORY, file_converter

AREAS = ["SE1", "SE2", "SE3", "SE4"]

LOG = structlog.get_logger()

@attr.s(auto_attribs=True)
class DayStatistics:
    day: date
    highest_price: str
    lowest_price: str
    average_price: str


def get_highest_price():
    ...


def save_year_statistics(year: str, price_area: str, stats: list[DayStatistics]):


    output = list()
    for price in stats:
        output.append(file_converter.unstructure(price))
    try:
        os.makedirs(f"{BASE_DIRECTORY}/{price_area}/{year}")
    except OSError:
        # folders exists
        pass
    path = f"{BASE_DIRECTORY}/{price_area}/{year}/stats.json"
    LOG.info("Saving updated statistics", path=path)
    with open(path, "w") as file:
        json.dump(output, file)

def get_saved_year_statistics(year_string: str, price_area: str) -> list[DayStatistics]:
    try:
        with open(f"{BASE_DIRECTORY}/{price_area}/{year_string}/stats.json", "r") as file:
            out = list()
            data = json.load(file)
            for item in data:
                out.append(file_converter.structure(item, DayStatistics))

            return out

    except FileNotFoundError:
        return list()


def remove_stats_files():
    years = ["2010", "2011", "2012", "2013", "2014", "2015", "2016", "2017", "2018", "2019", "2020", "2021", "2022"]
    for area in AREAS:
        for year in years:
            path = f"{BASE_DIRECTORY}/{area}/{year}/stats.json"
            if os.path.exists(path):
                os.remove(path)
            else:
                LOG.warning("Stats file missing during removal", path=path)


def calculate_statistic_for_day(day: date):
    for area in AREAS:
        LOG.info("Calculating statistics", day=day, area=area)
        today_string = day.strftime("%Y-%m-%d")
        year, _, _ = today_string.split("-")
        data = get_saved_prices_for_day(today_string, area)
        data.sort(key=lambda hv: float(hv.value))
        lowest_price = data[0].value
        #print(f"Lowest price = {lowest_price}")
        highest_price = data[-1].value
        #print(f"Highest price = {highest_price}")
        values = [float(item.value) for item in data]
        average = str(round(mean(values), 2))
        #print(f"Average = {average}")

        stats = DayStatistics(day=day, highest_price=highest_price, lowest_price=lowest_price, average_price=average)
        #print(stats)
        current_year_statistics = get_saved_year_statistics(year_string=year, price_area=area)
        current_year_statistics.append(stats)
        save_year_statistics(year, area, current_year_statistics)


if __name__ == "__main__":

    start_date = date.fromisoformat("2010-01-01")
    end_date = date.today()
    steps = timedelta(days=1)
    while start_date <= end_date:
        LOG.info("Running statistics calculation", start_date=start_date)
        calculate_statistic_for_day(start_date)
        start_date += steps

    #calculate_statistic_for_day(date.fromisoformat("2021-08-01"))

    #remove_stats_files()

