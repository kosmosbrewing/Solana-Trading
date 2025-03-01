import asyncio
import logging
import aiohttp
import util
from telethon import TelegramClient
from consts import *
from datetime import datetime, timedelta, timezone

# 스크래이핑할 채팅방 (채널 또는 그룹) 지정
chat_name = -1002122751413  # 채팅방 ID 또는 이름

util.setup_backtest_logging()
async def scrape_messages():
    twitter_data = {}

    util.load_remain_twitter(twitter_data)

    async with TelegramClient('session_name', API_ID, API_HASH) as client:
        try:
            await client.get_entity(chat_name)  # chat_id를 입력
        except Exception as e:
            logging.error(f"Get Telegram Entity : {e}")

        messages = []

        ##############################
        # Get Scraper Message
        ##############################
        try:
            async for message in client.iter_messages(chat_name, limit=50000):
                messages.append({
                    'id': message.id,
                    'curr_date': datetime.now(),
                    'issue_date': message.date + timedelta(hours=9),
                    'sender': message.sender_id,
                    'text': message.text
                })
        except Exception as e:
            logging.error(f"Get Telegram Messages : {e}")

        loop_count = 0
        # 메시지 출력
        for msg in messages:
            loop_count += 1
            try:
                ##############################
                # Store Scraper Message
                ##############################
                #print(msg['text'])
                ticker_value = msg['text'].split("**")[1].split("**")[0]
                ca_value = msg['text'].split("CA: `")[1].split("`")[0]
                price_value = msg['text'].split("Price: **$")[1].split("**")[0]
                mcp_value = msg['text'].split("MCP: **$")[1].split("**")[0]
                liq_value = msg['text'].split("Liq池子: **$")[1].split("**")[0]
                lp_value = msg['text'].split("LP底池: **")[1].split("**")[0].split("%")[0]

            except Exception as e:
                logging.error(f"Scrape Message : {e}")

            ##############################
            # Check Holder Count
            ##############################
            try:
                holder_value = msg['text'].split("Holder持有人: **")[1].split("**")[0]
            except:
                holder_value = -1

            ##############################
            # Check Renounced
            ##############################
            try:
                renounced_value = msg['text'].split("Renounced已弃权:")[1].split(" ")[1].split("\n")[0]

                if renounced_value == '✅':
                    renounced_value = 1
                elif renounced_value == '❌':
                    renounced_value = 0
            except:
                renounced_value = -1

            ##############################
            # Check Top Holder Rate
            ##############################
            try:
                top_rate_value = msg['text'].split("前10持仓:")[1].split(" ")[1].split("%")[0]
            except:
                top_rate_value = -1

            ##############################
            # Check Burning
            ##############################
            try:
                burn_rate_value = msg['text'].split("烧池子: ")[1].split(" ")[0].split("%")[0]
            except:
                burn_rate_value = -1

            ##############################
            # Check Rug Data
            ##############################
            try:
                rug_history_value = msg['text'].split("Rug Probability跑路概率: **")[1].split("**")[0].split("%")[0]
            except:
                rug_history_value = 0

            ##############################
            # Check Twitter Data
            ##############################
            try:
                twitter_value = 'x.com/' + msg['text'].split("Twitter](")[1].split(")")[0].split("x.com/")[1].split("?")[0].split("/")[0]

                if twitter_value not in twitter_data:
                    twitter_data[twitter_value] = { "len" : 0, "ca_list" : [] }

                if ca_value not in twitter_data[twitter_value]['ca_list']:
                    twitter_data[twitter_value]['ca_list'].append(ca_value)
                    twitter_data[twitter_value]['len'] = len(twitter_data[twitter_value]['ca_list'])

            except:
                twitter_value = 0

            '''
            ##############################
            # Check WebSite Data
            ##############################
            try:
                website_value = msg['text'].split("WebSite](")[1].split(")")[0]
            except:
                website_value = 0  
            '''

            dexscreener_data = await check_dexscreener(ca_value)
            initial_price = util.convert_to_float(price_value)

            try:
                current_price = float(dexscreener_data[0]['priceUsd'])
                current_liq = float(dexscreener_data[0]['liquidity']['usd'])
            except:
                current_price = -1
                current_liq = -1

            msg['curr_date'] = msg['curr_date'].replace(tzinfo=timezone.utc)
            msg['issue_date'] = msg['issue_date'].replace(tzinfo=timezone.utc)

            date_diff = msg['curr_date'] - msg['issue_date']

            if initial_price == -1 or current_price == -1:
                profit_rate = -1
            else:
                profit_rate = current_price / initial_price * 100 - 100

            result_message = f"|{ticker_value}|{profit_rate:.0f}|{current_liq:.0f}|{ca_value}|{mcp_value}|{liq_value}|{lp_value}|"
            result_message += f"{holder_value}|{renounced_value}|{top_rate_value}|{burn_rate_value}|{rug_history_value}|"
            result_message += f"{twitter_value}"

            logging.info(result_message)

            if loop_count % 100 == 0:
                util.put_remain_twitter(twitter_data)

        util.put_remain_twitter(twitter_data)
        util.load_remain_twitter(twitter_data)
        util.put_remain_twitter(twitter_data)
async def check_dexscreener(CA):
    server_url = f'https://api.dexscreener.com/tokens/v1/solana/{CA}'

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(server_url, ) as res:
                data = await res.json()
                return data
    except Exception as e:
        logging.error(f"Dex Screener : {e}")

if __name__ == '__main__':
    asyncio.run(scrape_messages())
