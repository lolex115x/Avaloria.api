# AvaloriaRP — checklista przed uruchomieniem na serwerze

## 1. Zmienne środowiskowe
**API (Railway):** `DATABASE_URL`, `INTERNAL_API_KEY` (to samo w botach), `MDT_ADMIN_DISCORD_IDS` (twoje ID Discorda), `SSN_POOL_REQUIRED` (domyślnie true), `MAX_CHARACTERS_PER_DISCORD` (3).
Opcjonalnie: `AUTO_OPEN_ACCOUNT=on` (konto bankowe zakładane razem z telefonem; domyślnie off), `PHONE_FACTION_PANELS=off` (ukrywa panele), `MDT_TABLET_ENABLED=on` (skrót tabletu w telefonie, domyślnie off), `ALARM_SILENT_DELAY_SECONDS` (90), `ALARM_ALSO_FACTIONS` (EMS), `INVOICE_VAT_PCT`.

**Bot główny (`flat/`):** `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `AVALORIA_API_URL`, `INTERNAL_API_KEY`, `DATABASE_URL`, istniejące role/kanały (`*_ROLE_ID`, `PODANIA_*`), oraz **tickety**:
`TICKET_CATEGORY_ID`, `TICKET_ARCHIVE_CATEGORY_ID` (opc.), `TICKET_STAFF_ROLE_IDS`, `TICKET_ADMIN_ROLE_IDS`, `TICKET_LOG_CHANNEL_ID`, `TICKET_MAX_OPEN_PER_USER` (3), `TICKET_COOLDOWN_SECONDS` (30).

## 2. Bot Discord — uprawnienia
Bot potrzebuje: Manage Channels, Manage Roles (dla kategorii), View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages (usuwanie wiadomości z hasłami). Intenty: Guilds, GuildMembers, GuildMessages, MessageContent (już włączone w kodzie — włącz też w Developer Portal).
Kategoria na tickety: bot musi mieć w niej dostęp. Kanał logów: tylko administracja.

## 3. Migracje
Uruchamiają się same przy starcie API (`CREATE/ALTER ... IF NOT EXISTS`): m.in. `invoices.kind`, tabele MDT, `discord_tickets` (bot). Brak migracji destrukcyjnych. Kopia bazy przed wdrożeniem: Railway → Postgres → Backups.

## 4. Test końcowy na serwerze (ok. 15 min)
1. Railway: API „Active”, w logach „baza danych gotowa”.
2. `/telefon ssn` → `/telefon aktywuj` → DM z danymi (albo wiadomość widoczna tylko dla ciebie, gdy DM zamknięte).
3. Zaloguj się w telefonie (F8) → wymusza zmianę hasła.
4. `/telefon reset-hasla` → nowe hasło, stare sesje wylogowane.
5. Nadaj sobie rolę LAPD → w telefonie „Panel LAPD”: wystaw mandat drugiej postaci, zapłać, sprawdź skarbiec.
6. Tickety: `/ticket panel` na kanale → otwórz każdy typ → zamknij → otwórz ponownie → transkrypt w logach → usuń.
7. EMS/DOT: faktura z VAT nadal działa.

## 5. Znane ograniczenia (uczciwie)
- ER:LC (darmowy plan) nie daje pozycji graczy ani zdarzeń napadów — alarm napadu jest zgłaszany ręcznie/komendą, **nie** „automatycznie z pozycją”.
- Radio w MDT to radio tekstowe (bez głosu).
- Napady na bank: w kodzie jest tylko punkt zaczepienia alarmu (`/internal/mdt/alarms`), brak pełnej mechaniki.
- Nie testowane na prawdziwym Discordzie/Railway/telefonie — tylko lokalnie (Postgres + Chromium) i na atrapie Discorda.

## 6. Błędy w logach — gdzie patrzeć
Railway → serwis API → Logs (błędy `console.error`; hasła i tokeny nie są logowane). Bot: logi hosta bota; prefiksy `[ticket]`, `[erlc]`. Audyt akcji: tabela `employee_logs` (logAction) w API, `discord_ticket_events` dla ticketów.

## 7. Wycofanie (rollback)
- Kod: poprzedni deploy w Railway → Deployments → Redeploy. Nowe kolumny/tabele są wsteczne-zgodne (można je zostawić).
- Panele: `PHONE_FACTION_PANELS=off` wyłącza panele bez zmiany kodu.
- Tickety: usuń `require('./tickets')` z `flat/index.js` lub nie ustawiaj zmiennych — bez nich moduł tylko loguje ostrzeżenia.
- Baza: odtworzenie z backupu Railway.
