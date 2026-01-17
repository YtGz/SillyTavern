# SillyTavern

LLM Frontend for Power Users

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## Voice WebSocket API

A WebSocket endpoint for voice-based interaction with SillyTavern.

### Usage

Connect to `ws://localhost:8000/ws/voice` (include your session cookies in the connection) and send JSON commands:

```json
{"action": "auth", "csrfToken": "<token from /csrf-token>"}
{"action": "message", "text": "Hello Luna"}
{"action": "switch", "character": "Luna"}
{"action": "generate", "body": { "messages": [...], "model": "gpt-4", "stream": true, ... }}
```

#### Actions

- **auth** - Set CSRF token for authenticated API calls (required before using `generate`)
- **message** - Send a text message (emits event for custom handling)
- **switch** - Switch the active character for the connection
- **generate** - Call the chat-completions API and stream the response back. The `body` field should contain the same payload you would send to `/api/backends/chat-completions/generate`.

#### Authentication Flow

1. Fetch CSRF token: `GET /csrf-token` (with session cookies)
2. Connect WebSocket with same session cookies
3. Send `{"action": "auth", "csrfToken": "<token>"}` to authenticate
4. Now `generate` commands will work

### Responses streamed back

- `{"type": "chunk", "text": "..."}` - Response text chunks (streamed incrementally)
- `{"type": "end"}` - End of response stream
- `{"type": "character_switched", "character": "..."}` - Character switch confirmation
- `{"type": "error", "message": "..."}` - Error messages

### Hook Points

The module emits `serverEvents.emit(EVENT_NAMES.VOICE_MESSAGE, {...})` and `serverEvents.emit(EVENT_NAMES.VOICE_SWITCH, {...})` for integration with ST's chat/character systems. Listeners can use the `streamChunk` and `streamEnd` callbacks to send responses back through the WebSocket.

## License

AGPL-3.0
