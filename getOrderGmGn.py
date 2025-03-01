import logging
import aiohttp
from consts import *
import base64
from base58 import b58decode
from solders.transaction import VersionedTransaction
from solders.keypair import Keypair

async def get_order(order_data):

    CA = order_data['ca_value']
    OUT_AMOUNT = order_data['out_amount']

    if order_data['type'] == 'buy':
        server_url = (
            f'https://gmgn.ai/defi/router/v1/sol/tx/get_swap_route?token_in_address={SOL_ADDRESS}&token_out_address={CA}'
            f'&in_amount={INPUT_SOL_AMOUNT}&from_address={FROM_ADDRESS}&slippage={SLIPPAGE}&is_anti_mev={True}&fee={ORDER_FEE}')
    else:
        server_url = (
            f'https://gmgn.ai/defi/router/v1/sol/tx/get_swap_route?token_in_address={CA}&token_out_address={SOL_ADDRESS}'
            f'&in_amount={OUT_AMOUNT}&from_address={FROM_ADDRESS}&slippage={SLIPPAGE}&is_anti_mev={True}&fee={ORDER_FEE}')

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(server_url) as res:
                logging.info(f"Request Route {order_data['type']}: {server_url}")
                route = await res.json()
                logging.info(f"Response Route {order_data['type']} : {route}")
                #order_data['out_amount'] = route['otherAmountThreshold']

    except Exception as e:
        logging.error(f"Request Order : {e}")

    base58_secret = b58decode(WALLET_KEY)
    wallet_payer = Keypair.from_bytes(base58_secret)
    swap_transaction_buf = base64.b64decode(route['data']['raw_tx']['swapTransaction'])
    transaction = VersionedTransaction.from_bytes(swap_transaction_buf)
    signed_tx = VersionedTransaction(transaction.message, [wallet_payer])
    signed_tx = base64.b64encode(bytes(signed_tx)).decode('ascii')

    #server_url = 'https://gmgn.ai/defi/router/v1/sol/tx/submit_signed_bundle_transaction'
    server_url = 'https://gmgn.ai/defi/router/v1/sol/tx/submit_signed_transaction'
    # 주문 정보 (예시 값)
    data = {
        'signed_tx': signed_tx,  # 거래 코인
        'from_address': FROM_ADDRESS
    }
    headers = {"Content-Type": "application/json"}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, headers=headers, json=data) as res:
                if res.status == 200:
                    try:
                        route = await res.json()
                        logging.info(f"Response Order {order_data['type']} : {route}")

                        return route
                    except ValueError:
                        logging.error("Response is not valid JSON")
                else:
                    logging.error(f"Request Order HTTP Error: {res.status}")
                    return -1

    except Exception as e:
        logging.error(f"Request Order : {e}")