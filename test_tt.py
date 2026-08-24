from TikTokLive import TikTokLiveClient
from TikTokLive.events import ConnectEvent

import sys

client = TikTokLiveClient(unique_id="rin.nivere")

@client.on(ConnectEvent)
async def on_connect(event: ConnectEvent):
    print(f"Connected to @{event.unique_id}")
    client.stop()

if __name__ == '__main__':
    try:
        client.run()
    except Exception as e:
        print(f"FAILED: {e.__class__.__name__} - {e}")
