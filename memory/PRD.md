# Teen Patti Settlement MVP

## Goal
Help a private card table record each game quickly and calculate a transparent final settlement without processing money.

## MVP
- Create a session with a game name, 2–20 players, base amount, and number of games
- Generate a short Game Code and private host token
- Start rounds, record PLAY/PACK/AMOUNT actions, undo the latest host action, and finish rounds with a winner
- Let other phones join as view-only participants and receive live state through short polling
- Show session summary, completed-round history, balances, minimum-transfer settlement, copy, and native share

## Accounting rule
Each player begins a round at the base amount. Their latest recorded contribution is used for that round. The winner receives the other players’ recorded contributions; all other players owe their recorded contribution. Completed rounds are accumulated using integer cents, then creditors and debtors are matched greedily.

## Deferred
Account sign-in, hosted WebSockets, player-specific permissions, and payment integrations are intentionally outside the first working version.