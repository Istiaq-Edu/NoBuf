import asyncio, json, sys, urllib.request

async def main():
    # find a page target
    data = json.load(urllib.request.urlopen("http://127.0.0.1:9223/json"))
    page = next((t for t in data if t.get("type") == "page"), None)
    if not page:
        print("NO PAGE TARGET", data); return
    import websockets
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=10*1024*1024) as ws:
        expr = """JSON.stringify({
          ua: navigator.userAgent,
          mse_hvc1_main:  MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"'),
          mse_hvc1_main10:MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L120.90"'),
          mse_hev1_main:  MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L120.90"'),
          mse_hev1_main10:MediaSource.isTypeSupported('video/mp4; codecs="hev1.2.4.L120.90"'),
          mse_avc:        MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"'),
          cpt_hvc1: document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"'),
          webcodecs: typeof VideoDecoder !== 'undefined'
        })"""
        await ws.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{"expression":expr,"returnByValue":True}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 1:
                print(msg["result"]["result"]["value"]); break
        # WebCodecs check (async)
        expr2 = """(async()=>{
          const r = {};
          for (const [k,c] of [['wc_hvc1_main','hvc1.1.6.L120.90'],['wc_hvc1_main10','hvc1.2.4.L120.90'],['wc_hev1_main10','hev1.2.4.L120.90']]) {
            try { const s = await VideoDecoder.isConfigSupported({codec:c, codedWidth:1920, codedHeight:1080, hardwareAcceleration:'prefer-hardware'}); r[k]=s.supported; }
            catch(e) { r[k]='ERR:'+e.message; }
          }
          try { const m = await navigator.mediaCapabilities.decodingInfo({type:'media-source', video:{contentType:'video/mp4; codecs="hvc1.2.4.L120.90"', width:1920, height:1080, bitrate:8000000, framerate:24}}); r.mediacap_main10 = m.supported; } catch(e){ r.mediacap_main10='ERR:'+e.message; }
          return JSON.stringify(r);
        })()"""
        await ws.send(json.dumps({"id":2,"method":"Runtime.evaluate","params":{"expression":expr2,"awaitPromise":True,"returnByValue":True}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 2:
                print(msg["result"]["result"]["value"]); break

asyncio.run(main())
