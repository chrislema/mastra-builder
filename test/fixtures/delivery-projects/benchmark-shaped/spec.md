# Talking Head Builder Spec

- Fetch recent bookmarks through the external Worker service binding `env.BOOKMARKS`.
- Generate candidates with Workers AI through `env.AI`.
- Store runs, candidates, and transcripts for completed transcript regeneration.
- Expose `GET /latest` for the latest `TranscriptResult`.
- Keep the public interface vanilla HTML, CSS, and JavaScript.
