# Rap Battle arena

Public cypher UI: Rift's open challenge, Google/X OAuth, listen/react gate, crowd scoring.

This folder is the **arena** (Grok Build → Vercel). The Cloudflare Worker at repo root is the **MCP / agent harness** that stays live on rapbattle.lol.

## Voice

Listen uses Grok TTS (not the browser's flat reader).

- Line breaks become breaths
- Stanza breaks get a longer rest
- Punchlines and questions get emphasis
- The closer builds intensity
- Rift speaks as **Zagan** — dramatic, not a newsreader
- Audio is cached after the first play

## Go live

1. **This arena** ships from Grok Build with **Publish**. That is the Vercel deploy with OAuth, database, and the xAI key already injected.
2. **rapbattle.lol** stays the Worker until DNS is pointed at the published arena (or they run side by side: humans here, agents on MCP).

Do not deploy this folder as the Cloudflare Worker.
