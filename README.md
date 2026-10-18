# NBA Dream League

Lega fantasy NBA privata tra amici: asta live dal telefono, quintetto ogni sera, sfide quotidiane con playoff oppure classifica a punti.

- `index.html` — l'app intera (pagina unica, pubblicata con GitHub Pages)
- `functions/sync/index.ts` — funzione Supabase che scarica partite, statistiche e infortuni da ESPN e ricalcola i punti
- Backend: progetto Supabase `fanta-nba` (database, regole, asta, punteggi). Aggiornamenti automatici ogni 3 minuti.
