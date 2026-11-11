# Wifly timeline: how "For you" is ranked

Code: `backend/src/rank.ts`. Tests: `backend/test/rank.test.ts` (pure scoring) and `backend/test/api.test.ts` (end to end).
The **Following** tab is not ranked: it is strictly newest first (your follows' drops and their passes).

## Score

Each top-level drop from the last 7 days gets:

```
score = (1 + engagement) × velocity × recency × affinity × interest × trust × media × notInterested
```

| part | formula | why |
|---|---|---|
| engagement | ln(1 + likes + 2·replies + 2.5·passes + 2.5·quotes + 1.5·bookmarks) + 1.5·ln(1 + tipped/10) + 1.5·ln(1 + votes/10) | log so big numbers don't run away; tips and votes cost WIF so they count more |
| velocity | 1 + 0.4·min(2.5, ln(1 + (likes + 2·replies + 3·ln(1 + tipped/10)) / max(1, age h))) | drops picking up fast get up to ×2 |
| recency | 0.5^(age h / 18) | 18-hour half-life |
| affinity | 1 + 1.2 if you follow them + 0.5·ln(1 + your likes/replies/passes of them in 30 days) + 0.3 if people you follow follow them | your people first |
| interest | 1 + 0.9·min(1, Σ tag weights) | interests you picked at sign-up count 0.6 each; tags you like (1), reply to (1.5) or post (0.5) are learned with a 14-day half-life |
| trust | age × reach × spam, never below 0.2 | account < 1 day ×0.5, < 7 days ×0.8; 0 followers ×0.85; 2+ links ×0.6; mostly caps ×0.7; hidden by 3+ people ×0.6 |
| media | ×1.1 with an image or media card | |
| notInterested | 0.6^(times you hid this author) | |

A drop passed on by someone you follow is scored as if it were fresher (halfway between posted and passed) with affinity at least 1.8.

## Re-rank

Greedy over the top 60 candidates:
1. The k-th drop from the same author is multiplied by 0.55^k.
2. The same author never shows twice in a row (unless nobody else is left).
3. Every 5th slot is a **discovery** pick: the best drop from someone outside your circle (not followed, not followed by your follows, no past interaction). Only when you follow someone; guests just get the ranked list.
4. Each drop appears once. Your own drops from the last 15 minutes are pinned on top.

Pages are cut from a ranking snapshot, so scrolling is stable while new drops arrive.

## "Why am I seeing this"

Each For-you item carries one line, from the strongest signal, in this order:
passed on by someone you follow → you follow @x → someone new (discovery slot) → you picked #tag as an interest →
you often like #tag → you often reply to or like @x → people you follow follow @x → picking up fast right now → popular this week → new on wifly.

## Guests

Logged-out visitors get the same ranking with no personal signals, capped at the first 8 drops (`capForGuest`), then a "sign up to see more" card.
