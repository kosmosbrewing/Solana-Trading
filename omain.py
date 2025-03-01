import asyncio
import checkPosition
import getNewLPScraper
import util
import traceback
import logging
from consts import *
class Premium:
    def __init__(self):
        self.trade_data = {"recent_ca" : "init", "remain_sol" : REMAINING_SOL}
        self.position_data = {}
        self.twitter_data = {}
        util.setup_logging()
    async def run(self):
        await asyncio.wait([
            asyncio.create_task(self.getNewLPScraper()),
            asyncio.create_task(self.checkPosition()),
            asyncio.create_task(self.storeData()),
        ])
    async def getNewLPScraper(self):
        util.load_remain_position(self.position_data)
        util.load_remain_twitter(self.twitter_data)

        loop = 0
        while True:
            try:
                await asyncio.sleep(0.5)
                await getNewLPScraper.scrape_messages(self.trade_data, self.position_data, self.twitter_data)

                if loop % 200 == 0:
                    logging.info("getNewLPScraper Still Running")

                loop += 1
            except Exception as e:
                logging.info(traceback.format_exc())
                await asyncio.sleep(30)

    async def checkPosition(self):
        loop = 0
        while True:
            try:
                await asyncio.sleep(10)
                await checkPosition.check_position(self.position_data, self.twitter_data, self.trade_data)

                if loop % 10 == 0:
                    logging.info("checkPosition Still Running")

                loop += 1
            except Exception as e:
                logging.info(traceback.format_exc())
                await asyncio.sleep(30)

    async def storeData(self):
        while True:
            try:
                await asyncio.sleep(60)
                util.put_remain_position(self.position_data)
                util.put_remain_twitter(self.twitter_data)
            except Exception as e:
                logging.info(traceback.format_exc())
                await asyncio.sleep(30)

if __name__ == "__main__":
    premium = Premium()
    asyncio.run(premium.run())