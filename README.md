# SillyTavern

LLM Frontend for Power Users

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## Voice WebSocket API

A WebSocket endpoint for voice-based interaction with SillyTavern. Uses a headless browser internally to leverage ST's full prompt-building logic (character cards, lorebooks, instruct templates, etc.).

### Connection

Connect to `ws://localhost:8000/ws/voice`

On connection, you'll receive a status message:
```json
{"type": "status", "ready": true, "character": null, "headlessReady": false}
```

The `headlessReady` field indicates whether the headless browser has finished initializing. It starts automatically on first connection.

### Commands

All commands are JSON objects with an `action` field:

#### status
Get current status and selected character.
```json
{"action": "status"}
```
Response: `{"type": "status", "ready": true, "character": "Luna", "headlessReady": true}`

#### characters
List available characters.
```json
{"action": "characters"}
```
Response: `{"type": "characters", "characters": [{"name": "Luna", "avatar": "Luna.png"}, ...]}`

#### switch
Select a character by name.
```json
{"action": "switch", "character": "Luna"}
```
Response: `{"type": "character_switched", "character": "Luna"}`

#### message
Send a message and receive the AI's streamed response. This uses ST's full context (character cards, lorebooks, chat history, etc.).
```json
{"action": "message", "text": "Hello, how are you today?"}
```
Response:
```json
{"type": "chunk", "text": "Hello"}
{"type": "chunk", "text": "! I'm"}
{"type": "chunk", "text": " doing"}
{"type": "chunk", "text": " great"}
{"type": "end", "fullText": "Hello! I'm doing great, thank you for asking!"}
```

#### history
Get the current chat history.
```json
{"action": "history"}
```
Response: `{"type": "history", "messages": [{"is_user": true, "mes": "Hi", "name": "User"}, ...]}`

#### stop
Stop an ongoing generation.
```json
{"action": "stop"}
```

#### generate (Low-level API)
Direct LLM API call - bypasses ST's prompt building. Use `message` instead for full ST integration.
```json
{"action": "generate", "body": {"messages": [...], "model": "gpt-4", "stream": true}}
```
Requires auth first:
```json
{"action": "auth", "csrfToken": "<token from /csrf-token>"}
```

### Response Types

- `{"type": "status", ...}` - Status information
- `{"type": "characters", ...}` - Character list
- `{"type": "history", ...}` - Chat history
- `{"type": "character_switched", "character": "..."}` - Character switch confirmation
- `{"type": "chunk", "text": "..."}` - Response text chunk (streamed)
- `{"type": "end", "fullText": "..."}` - End of response with complete text
- `{"type": "error", "message": "..."}` - Error message

### Example Client (Python)

```python
import asyncio
import websockets
import json

async def voice_chat():
    async with websockets.connect('ws://localhost:8000/ws/voice') as ws:
        # Wait for initial status
        status = json.loads(await ws.recv())
        print(f"Connected: {status}")
        
        # Wait for headless browser to be ready
        while not status.get('headlessReady'):
            await asyncio.sleep(1)
            await ws.send(json.dumps({"action": "status"}))
            status = json.loads(await ws.recv())
        
        # Select a character
        await ws.send(json.dumps({"action": "switch", "character": "Luna"}))
        response = json.loads(await ws.recv())
        print(f"Character: {response}")
        
        # Send a message
        await ws.send(json.dumps({"action": "message", "text": "Hello!"}))
        
        # Collect streamed response
        full_response = ""
        while True:
            msg = json.loads(await ws.recv())
            if msg['type'] == 'chunk':
                full_response += msg['text']
                print(msg['text'], end='', flush=True)
            elif msg['type'] == 'end':
                print()  # newline
                break
            elif msg['type'] == 'error':
                print(f"Error: {msg['message']}")
                break

asyncio.run(voice_chat())
```

### Architecture

The WebSocket server uses Puppeteer to run a headless instance of SillyTavern's web UI. This allows it to use all of ST's frontend logic for prompt building, including:

- Character cards and descriptions
- Lorebooks and world info
- Instruct templates and system prompts
- Chat history and message formatting
- Token counting and context management
- Extensions and preprocessing

The headless browser initializes automatically on first WebSocket connection (~150-250 MB memory, ~5-10 second startup).

## License

AGPL-3.0
