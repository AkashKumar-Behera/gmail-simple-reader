import sys
import asyncio
import edge_tts

# Usage:
# python tts.py "text here" "voice_name"

text = sys.argv[1]
voice = sys.argv[2]

async def generate():
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save("public/tts.mp3")

asyncio.run(generate())