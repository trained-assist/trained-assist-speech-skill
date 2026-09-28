'use strict';

// Speech domain tools (Ф0). Single prefix `speech_` — tool names must never collide
// with another repo (mcp-action.js treats a duplicate as CONFLICT), which is why the
// legacy `video_set_deepgram_key` alias stays in trained-assist-agent's core.
//
// Contract: docs/user-scenarios/speech/01-speech-transcribe.md (core repo),
// design: docs/user-scenarios/speech/03-proposal-design.md §2.2–2.4.

module.exports = {
  // Always visible: without the key the user still has to be able to set it,
  // and a missing key must produce a typed error, never "Unknown tool".
  isReady: () => true,
  setupTools: ['speech_set_key', 'speech_status'],

  tools: {},
};
