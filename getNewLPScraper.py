import asyncio
import logging
import traceback
import aiohttp
import util
import json
import getOrderGmGn
from telethon import TelegramClient
from consts import *
from datetime import datetime, timedelta, timezone

# 스크래이핑할 채팅방 (채널 또는 그룹) 지정
chat_name = -1002122751413  # 채팅방 ID 또는 이름

async def scrape_messages(trade_data, position_data, twitter_data):
    async with TelegramClient('session_name', API_ID, API_HASH) as client:
        # 로그인 (첫 실행 시 필요)
        '''
        dialogs = await client.get_dialogs()  # 사용자의 모든 채팅 목록 가져오기

        for dialog in dialogs:
            print(f"채팅방 이름: {dialog.name}, ID: {dialog.id}")
        '''
        try:
            await client.get_entity(chat_name)  # chat_id를 입력
            # print(f"이름: {entity.title}, ID: {entity.id}")
        except Exception as e:
            logging.error(f"Get Telegram Entity : {e}")

        messages = []

        ##############################
        # Get Scraper Message
        ##############################
        try:
            async for message in client.iter_messages(chat_name, limit=1):  # 최근 100개 메시지
                messages.append({
                    'id': message.id,
                    'curr_date': datetime.now(),
                    'issue_date': message.date + timedelta(hours=9),
                    'sender': message.sender_id,
                    'text': message.text
                })
        except Exception as e:
            logging.error(f"Get Telegram Messages : {e}")

        for msg in messages:
            try:
                ##############################
                # Store Scraper Message
                ##############################
                ticker_value = msg['text'].split("**")[1].split("**")[0]
                ca_value = msg['text'].split("CA: `")[1].split("`")[0]
                price_value = msg['text'].split("Price: **$")[1].split("**")[0]
                mcp_value = msg['text'].split("MCP: **$")[1].split("**")[0]
                liq_value = msg['text'].split("Liq池子: **$")[1].split("**")[0]
                lp_value = msg['text'].split("LP底池: **")[1].split("**")[0].split("%")[0]

            except Exception as e:
                logging.error(f"Scrape Message : {e}")
                '''
                if "Harry" in ticker_value or "harry" in ticker_value or "bolz" in ticker_value or "Bolz" in ticker_value:
                    print(f"포함 티커 명 : {ticker_value}")
                else:
                    print(f"제외 티커 명 : {ticker_value}")
                    break
                '''

            ##############################
            # Check Twitter Data
            ##############################
            try:
                twitter_value = 'x.com/' + msg['text'].split("Twitter](")[1].split(")")[0].split("x.com/")[1].split("?")[0].split("/")[0]

                if twitter_value not in twitter_data:
                    twitter_data[twitter_value] = {"len": 0, "ca_list": []}

                if ca_value not in twitter_data[twitter_value]['ca_list']:
                    twitter_data[twitter_value]['ca_list'].append(ca_value)
                    twitter_data[twitter_value]['len'] = len(twitter_data[twitter_value]['ca_list'])
                    logging.info(f"Add Twitter Value : {twitter_value}[{twitter_data[twitter_value]['len']}]")

                if twitter_data[twitter_value]['len'] > 1:
                    break
            except:
                twitter_value = 0

            if trade_data['recent_ca'] == ca_value:
                break

            ##############################
            # Check Market Cap Size
            ##############################
            if "K" in mcp_value or "M" in mcp_value:
                break

            ##############################
            # Check Liquidity Cap Size
            ##############################
            ### 마켓캡이 큰데 LP 비율이 높으면 버리기
            if float(mcp_value) > 10000 and float(lp_value) > 90:
                break

            ##############################
            # Check Holder Count
            ##############################
            try:
                holder_value = msg['text'].split("Holder持有人: **")[1].split("**")[0]
            except:
                holder_value = -1

            if float(holder_value) > 50:
                break

            ##############################
            # Check Renounced
            ##############################
            try:
                renounced_value = msg['text'].split("Renounced已弃权:")[1].split(" ")[1].split("\n")[0]

                if renounced_value == '✅':
                    renounced_value = 1
                elif renounced_value == '❌':
                    renounced_value = 0
                    break
            except:
                renounced_value = -1

            ##############################
            # Check Top Holder Rate
            ##############################
            try:
                top_rate_value = msg['text'].split("前10持仓:")[1].split(" ")[1].split("%")[0]

                if float(top_rate_value) > 85:
                    break
            except:
                top_rate_value = -1

            ##############################
            # Check Burning
            ##############################
            try:
                burn_rate_value = msg['text'].split("烧池子: ")[1].split(" ")[0].split("%")[0]

                if float(burn_rate_value) != 100:
                    break
            except:
                burn_rate_value = -1

            ##############################
            # Check Rug Data
            ##############################
            try:
                rug_history_value = msg['text'].split("Rug Probability跑路概率: **")[1].split("**")[0].split("%")[0]

                if float(rug_history_value) > 10:
                    break
            except:
                rug_history_value = 0

            try:
                ##############################
                # Check Datatime Gap
                ##############################
                msg['curr_date'] = msg['curr_date'].replace(tzinfo=timezone.utc)
                msg['issue_date'] = msg['issue_date'].replace(tzinfo=timezone.utc)

                date_diff = msg['curr_date'] - msg['issue_date']
                date_diff_seconds = date_diff.total_seconds()

                if date_diff_seconds > 3:
                    break

                if trade_data['remain_sol'] <= 0.01:
                    break
                ##############################
                # Order GMGN !!!!!
                ##############################
                order_data = {
                    "ca_value" : ca_value,
                    "type" : "buy",
                    "out_amount" : 0
                }
                order_result = await getOrderGmGn.get_order(order_data)

                try:
                    if order_result['msg'] != 'success':
                        break
                    elif order_result['data']['hash'] == None:
                        logging.info(order_result)
                        break

                    open_tx = order_result['data']['hash']
                except:
                    break

                ##############################
                # Make Position data
                ##############################
                trade_data['recent_ca'] = ca_value
                trade_data['remain_sol'] -= INPUT_SOL
                dexscreener_data = await check_dexscreener(ca_value)

                try:
                    open_price = float(dexscreener_data[0]['priceUsd'])
                except:
                    open_price = float(util.convert_to_float(price_value))

                position_data[ca_value] = {
                    "ticker" : ticker_value,
                    "exit_flag": 0,
                    "open_time" : datetime.now().isoformat(),
                    "open_price" : open_price,
                    "open_amount" : 0,
                    "current_price" : 0,
                    "current_liq" : None,
                    "profit_rate" : None,
                    "twitter_value" : twitter_value,
                    "open_tx" : open_tx
                }

                result_message = f"|{ticker_value}|{ca_value}|{mcp_value}|{liq_value}|{lp_value}"
                result_message += f"|{holder_value}|{renounced_value}|{top_rate_value}|{burn_rate_value}"
                result_message += f"|{rug_history_value}|{twitter_value}"
                logging.info(f"{result_message}")

            except Exception as e:
                logging.error(f"Scrape Message Order : {e}")
async def check_dexscreener(CA):
    server_url = f'https://api.dexscreener.com/tokens/v1/solana/{CA}'

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(server_url) as res:
                data = await res.json()
                return data
    except Exception as e:
        logging.error(f"Dex Screener : {e}")



