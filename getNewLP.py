import asyncio
import logging

import websockets
import json
from solana.rpc.api import Client
from solders.pubkey import Pubkey
from solders.signature import Signature
import pandas as pd
import util
import asyncio
from tabulate import tabulate

wallet_address = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
seen_signatures = set()
solana_client = Client("https://api.mainnet-beta.solana.com")

async def getTokens(str_signature):
    signature = Signature.from_string(str_signature)
    transaction = solana_client.get_transaction(signature, encoding="jsonParsed",
                                                max_supported_transaction_version=0).value
    instruction_list = transaction.transaction.transaction.message.instructions

    for instructions in instruction_list:
        if instructions.program_id == Pubkey.from_string(wallet_address):

            message = "============NEW POOL DETECTED===================="

            Token0 = instructions.accounts[8]
            Token1 = instructions.accounts[9]
            # Your data
            data = {'Token_Index': ['Token0', 'Token1'],
                    'Account Public Key': [Token0, Token1]}

            df = pd.DataFrame(data)
            table = tabulate(df, headers='keys', tablefmt='fancy_grid')
            message = table

            await util.send_to_telegram(message)
            logging.info(message)

async def run():
    uri = "wss://api.mainnet-beta.solana.com"

    async with websockets.connect(uri, ping_interval=20, ping_timeout=30) as websocket:
        # Send subscription request
        await websocket.send(json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "programSubscribe",
            "params": [
                {"mentions": [wallet_address]},
                {"commitment": "finalized"}
            ]
        }))

        logging.info(f"Connect WebSocket : {uri}, Waiting Data...")

        first_resp = await websocket.recv()
        response_dict = json.loads(first_resp)

        if 'result' in response_dict:
            logging.info("Subscription successful. Subscription ID: ", response_dict['result'])

        # Continuously read from the WebSocket
        async for response in websocket:
            response_dict = json.loads(response)

            if response_dict['params']['result']['value']['err'] == None:
                signature = response_dict['params']['result']['value']['signature']

                if signature not in seen_signatures:
                    seen_signatures.add(signature)
                    log_messages_set = set(response_dict['params']['result']['value']['logs'])

                    search = "initialize2"
                    if any(search in message for message in log_messages_set):
                        logging.info(f"True, https://solscan.io/tx/{signature}")
                        await getTokens(signature)
            else:
                pass
'''
async def main():
    await run()

if __name__ == "__main__":
    asyncio.run(main())
'''