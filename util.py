import json
import re
import traceback

import telegram
import asyncio
import aiohttp
import logging
import datetime
from logging.handlers import TimedRotatingFileHandler
from consts import *
from datetime import datetime, timezone, timedelta
bot = None
chat_id_list = None

def setup_logging():
    logging.basicConfig(level=logging.INFO)
    # TimedRotatingFileHandler를 설정하여 날짜별로 로그 파일을 회전
    if ENV == 'real':
        log_file_path = '/root/premium/log/premium.log'
    elif ENV == 'local':
        log_file_path = 'C:/Users/skdba/PycharmProjects/premium/log/premium.log'

    # 파일 핸들러 생성 및 설정

    file_handler = TimedRotatingFileHandler(filename=log_file_path, when='midnight', interval=1, backupCount=30)
    file_handler.suffix = "%Y%m%d"
    file_handler.setLevel(logging.INFO)
    logging.getLogger('telethon').setLevel(logging.WARNING)
    logging.getLogger('asyncio').setLevel(logging.WARNING)

    # 로그 포매터 설정
    if ENV == 'real':
        formatter = logging.Formatter('[%(asctime)s][%(levelname)s]:%(message)s')
    elif ENV == 'local':
        formatter = logging.Formatter('[%(asctime)s][%(levelname)s]:%(message)s ...(%(filename)s:%(lineno)d)')

    file_handler.setFormatter(formatter)

    # 루트 로거에 핸들러 추가
    root_logger = logging.getLogger()
    root_logger.addHandler(file_handler)

def setup_backtest_logging():
    logging.basicConfig(level=logging.INFO)
    # TimedRotatingFileHandler를 설정하여 날짜별로 로그 파일을 회전
    if ENV == 'real':
        log_file_path = '/root/premium/log/backtest.log'
    elif ENV == 'local':
        log_file_path = 'C:/Users/skdba/PycharmProjects/premium/log/backtest.log'

    # 파일 핸들러 생성 및 설정

    file_handler = TimedRotatingFileHandler(filename=log_file_path, when='midnight', interval=1, backupCount=30)
    file_handler.suffix = "%Y%m%d"
    file_handler.setLevel(logging.INFO)
    logging.getLogger('telethon').setLevel(logging.WARNING)
    logging.getLogger('asyncio').setLevel(logging.WARNING)

    # 로그 포매터 설정
    if ENV == 'real':
        formatter = logging.Formatter('[%(asctime)s][%(levelname)s]:%(message)s')
    elif ENV == 'local':
        formatter = logging.Formatter('[%(asctime)s][%(levelname)s]:%(message)s ...(%(filename)s:%(lineno)d)')

    file_handler.setFormatter(formatter)

    # 루트 로거에 핸들러 추가
    root_logger = logging.getLogger()
    root_logger.addHandler(file_handler)

def convert_to_float(num_str):
    # 정규식을 사용하여 '{숫자}' 형식 제거
    cleaned_str = re.sub(r"0\.0\{(\d+)\}", lambda m: "0." + "0" * int(m.group(1)), num_str)
    # 실수로 변환
    try:
        num_float = float(cleaned_str)
        return num_float
    except ValueError as e:
        logging.error(f"convert_to_float : {e}")
async def get_chat_id():
    logging.info("Telegram Chat ID 요청합니다..")
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates') as response:
                if response.status == 200:
                    data = await response.json()
                    chat_id_group = data['result']
                    chat_id_list = []
                    for result in chat_id_group:
                        chat_id_list.append(result['message']['chat']['id'])
                    chat_id_list = list(set(chat_id_list))
                    logging.info(f"Telegram Chat ID 응답 : {chat_id_list}")
                    return chat_id_list
                else:
                    logging.info(f"Telegram Chat ID 요청 응답 오류: {response.status}")
        except aiohttp.ClientError as e:
            logging.info(f"Telegram 세션 연결 오류: {e}")

async def send_to_telegram(message):
    # 텔레그램 메시지 보내는 함수, 최대 3회 연결, 3회 전송 재시도 수행
    global bot
    global chat_id_list

    if chat_id_list is None:
        chat_id_list = await get_chat_id()
        #logging.info(f"Telegram Chat ID 값 취득 : {get_chat_id()}")
        # chat_id_list = ['1109591824'] # 준우
        # chat_id_list = ['1109591824', '2121677449']  #
        chat_id_list = ['2121677449']  # 규빈
        logging.info(f"Telegram Chat ID 값 취득 : {chat_id_list}")

    if bot is None:
        logging.info("Telegram 연결 시도...")
        bot = telegram.Bot(token=TELEGRAM_BOT_TOKEN)

    for chat_id in chat_id_list:
        for i in range(3):
            try:
                # logging.info(f"Telegram [{chat_id}], msg 전송 {message}")
                await bot.send_message(chat_id, message[:TELEGRAM_MESSAGE_MAX_SIZE])
                break
            except telegram.error.TimedOut as e:
                logging.info(f"Telegram {chat_id} msg 전송 오류... {i + 1} 재시도... : {e}")
                
                await asyncio.sleep(5)
            except Exception as e:
                logging.info(f"Telegram 연결 해제... {e}")
                bot = None
                break

async def send_to_telegram_image(image):
    # 텔레그램 메시지 보내는 함수, 최대 3회 연결, 3회 전송 재시도 수행
    global bot
    global chat_id_list

    message = '[News Coo 🦤]\n🔵진입김프(UPBIT⬆️/BINANCE⬇️)|\n🔴탈출김프(UPBIT⬇️/BINANCE⬆️)|\n⚫️Bitcoin진입김프(UPBIT⬆️/BINANCE⬇️)'
    if chat_id_list is None:
        chat_id_list = await get_chat_id()
        chat_id_list = ['1109591824', '2121677449']  #
        logging.info(f"Telegram Chat ID 값 취득 : {chat_id_list}")

    if bot is None:
        logging.info("Telegram 연결 시도...")
        bot = telegram.Bot(token=TELEGRAM_BOT_TOKEN)

    for chat_id in chat_id_list:
        for i in range(3):
            try:
                # logging.info(f"Telegram [{chat_id}], msg 전송 {message}")
                await bot.send_message(chat_id, message[:TELEGRAM_MESSAGE_MAX_SIZE])
                await bot.send_photo(chat_id, photo=open(image, 'rb'))
                break
            except telegram.error.TimedOut as e:
                logging.info(f"Telegram {chat_id} msg 전송 오류... {i + 1} 재시도... : {e}")
                await asyncio.sleep(5)
            except Exception as e:
                logging.info(f"Telegram 연결 해제... {e}")
                bot = None
                break

def load_remain_position(position_data):

    if ENV == 'real':
        load_path = '/root/premium/data/position_data.json'
    elif ENV == 'local':
        load_path = 'C:/Users/skdba/PycharmProjects/premium/data/position_data.json'

    if os.path.exists(load_path):
        with open(load_path, 'r', encoding='utf-8') as file:
            lines = file.readlines()

        for line in lines:
            try:
                load_data = json.loads(line)
                #logging.info(f"Load Position : {load_data}")
                for ca_value in load_data:
                    position_data[ca_value] = load_data[ca_value]
            except Exception as e:
                logging.error(f"load_remain_position : {e}")

    else:
        logging.info(f"{load_path} There is no file")


def put_remain_position(position_data):
    put_path = ''

    if ENV == 'real':
        put_path = '/root/premium/data/position_data.json'
    elif ENV == 'local':
        put_path = 'C:/Users/skdba/PycharmProjects/premium/data/position_data.json'

    try:
        with open(put_path, 'w') as file:
            file.write(json.dumps(position_data))
    except Exception as e:
        logging.error(f"put_remain_position : {e}")


def load_remain_twitter(twitter_data):

    if ENV == 'real':
        load_path = '/root/premium/data/twitter_data.json'
    elif ENV == 'local':
        load_path = 'C:/Users/skdba/PycharmProjects/premium/data/twitter_data.json'

    if os.path.exists(load_path):
        with open(load_path, 'r', encoding='utf-8') as file:
            lines = file.readlines()

        for line in lines:
            try:
                load_data = json.loads(line)
                for twitter_value in load_data:
                    if twitter_value not in twitter_data:
                        twitter_data[twitter_value] = {"len": 0, "ca_list": None}
                    twitter_data[twitter_value]['ca_list'] = load_data[twitter_value]['ca_list']
                    twitter_data[twitter_value]['len'] = load_data[twitter_value]['len']
            except Exception as e:
                logging.error(f"load_remain_twitter : {e}")

    else:
        logging.info(f"{load_path} There is no file")

def put_remain_twitter(twitter_data):
    put_path = ''

    if ENV == 'real':
        put_path = '/root/premium/data/twitter_data.json'
    elif ENV == 'local':
        put_path = 'C:/Users/skdba/PycharmProjects/premium/data/twitter_data.json'

    try:
        with open(put_path, 'w') as file:
            file.write(json.dumps(twitter_data))
    except Exception as e:
        logging.error(f"put_remain_twitter : {e}")




def put_twitter_get():
    twitter_data = {}

    put_path = 'C:/Users/skdba/PycharmProjects/premium/data/twitter_data.json'
    load_path = 'C:/Users/skdba/PycharmProjects/premium/log/backtest.log_all'

    if os.path.exists(load_path):
        with open(load_path, 'r', encoding='utf-8') as file:
            lines = file.readlines()

        for line in lines:
            try:
                ca_value = line.split('|')[4]
                twitter_value = line.split('|')[13].split('\n')[0]

                if twitter_value == '0':
                    continue
                else:
                    print(f"{ca_value}|{twitter_value}")

                    if twitter_value not in twitter_data:
                        twitter_data[twitter_value] = { "len" : 0, "ca_list" : [] }

                    if ca_value not in twitter_data[twitter_value]['ca_list']:
                        twitter_data[twitter_value]['ca_list'].append(ca_value)
                        twitter_data[twitter_value]['len'] = len(twitter_data[twitter_value]['ca_list'])

            except Exception as e:
                continue
    try:
        with open(put_path, 'w') as file:
            file.write(json.dumps(twitter_data))
    except Exception as e:
        logging.error(f"put_remain_twitter : {e}")

    load_remain_twitter(twitter_data)
    put_remain_twitter(twitter_data)

    print(json.dumps(twitter_data,indent=4))

if __name__ == '__main__':
    put_twitter_get()
