# Decisions

- 2026-10-19 (P06): Verified Google’s Gemini REST `generateContent` guidance: use `v1beta/models/{model}:generateContent`, `generationConfig.responseMimeType` plus `responseSchema` for structured JSON, and `parts[].inlineData` for inline images; default cloud model is the configurable `gemini-3.8-flash`.
- 2026-10-19 (P06): Cloud provider keys remain only in `server/.env`; the extension stores only the user-created token that authorizes the local proxy.
- 2026-10-19 (P06): Hybrid sends text planning to local AI first and falls back to cloud only after a local failure and explicit consent; visual analysis always requires cloud consent.
