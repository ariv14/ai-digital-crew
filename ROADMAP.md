# AI Digital Crew — Roadmap

> Ideas to evolve from a passive showcase into an actively useful platform.
> Status: research phase — not yet prioritised or scheduled.

---

## Direction 1: AI Tool Finder (Semantic Search)
Turn the site into a search engine for AI tools. Users describe what they want to do, and we return matching open-source projects using semantic/embedding-based search.

- Replace keyword filter with natural language search
- Embed project descriptions using Gemini embeddings
- Store vectors in Firestore or a lightweight vector DB
- "I need to do X" → ranked list of relevant projects

---

## Direction 2: AI Project Radar (Trend Tracking)
Track momentum over time — stars, forks, commit activity. Surface rising, trending, and declining projects.

- Store historical star/fork snapshots in Firestore
- Compute week-over-week momentum scores
- Add "Trending", "Rising", "Hot this week" filters to the UI
- Let users subscribe to category alerts

---

## Direction 3: Weekly AI Digest Newsletter
Package the best discoveries of the week into a curated newsletter with commentary.

- Already have daily scrape pipeline — aggregate into weekly picks
- Write short editorial blurbs per project (Gemini-assisted)
- Publish via Substack or email
- Build a subscriber audience

---

## Direction 4: "Deploy This" One-Click Templates
For each featured project, add a one-click deploy button (Railway, Render, Vercel, etc.).

- Detect project type (Node, Python, Docker, etc.) from repo metadata
- Map to appropriate hosting platform
- Lower the barrier from "discovery" to "running it"

---

## Direction 5: Contributor Matchmaking
Connect developers who want to contribute with projects that need help.

- Add "looking for contributors" tag to projects
- Let devs filter by language, skill, or project type
- Optional: notify project owners when someone expresses interest

---

## Notes
- Directions 1 + 2 are the strongest near-term bets — data pipeline already exists
- Direction 3 is low effort, high compounding value (audience building)
- Directions 4 + 5 require more UX thinking and potentially owner opt-in
- Inspiration: openclaw.ai (active utility vs passive browsing)
