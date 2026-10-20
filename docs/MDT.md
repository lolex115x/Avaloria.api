# AvaloriaRP – Tablet MDT, Dispatch i Radio

Tablet to **osobna aplikacja** pod `/mdt/` (ten sam serwer, baza i konta co telefon), ale z własnym manifestem (`/mdt/manifest.json`, zakres `/mdt/`, poziomo), własnymi ikonami i własnym service workerem – instaluje się jako osobna aplikacja („Zainstaluj aplikację” / „Dodaj do ekranu głównego”). Na komputer jest też osobny program Electron: `avaloria-mdt-desktop` (zwykłe okno, nie nakładka F8). Telefon AvaloriaRP **nie został usunięty ani okrojony**:
zostały Bank, Ćwierk, Wiadomości, Kontakty, Sklep, Plecak, Ustawienia, Darkweb, połączenia, kryptowaluty, kontrakty. Do siatki aplikacji doszła tylko ikona **Tablet MDT** (skrót).

## Architektura
- Front: `public/mdt/{index.html,mdt.css,mdt.js}` – czysty JS, bez bibliotek zewnętrznych. Token w `localStorage.mdt_token` (wylogowanie z MDT nie rusza telefonu).
  Skrót z telefonu otwiera `/mdt/?sso=1` i przejmuje tę samą sesję postaci.
- Back: `mdt/` (Express, Postgres): `core.js` (RBAC, audyt, służba, personel, admin), `dispatch.js`, `records.js` (osoby/pojazdy/poszukiwani/raporty), `doj.js`, `radio.js`, `alarms.js`.
- Dane frakcji: dotychczasowe tabele (`faction_members`, `faction_duty`, `tickets`, `ticket_log`, `medical_records`, `invoices`, skarbiec). Panele telefonu i tablet czytają **te same** rekordy – nic nie jest kopiowane.
- Rangi: źródłem prawdy pozostają role Discorda (synchronizacja bota). Zmiana Pracownik↔Zastępca w tablecie działa do następnej synchronizacji roli.
- Aktywna frakcja: nagłówek `X-MDT-Faction`, ale serwer przy **każdym** żądaniu sprawdza, że użytkownik naprawdę jest (niezawieszonym) członkiem tej frakcji.
- Odświeżanie: polling (dispatch co 3 s z licznikiem rewizji `mdt_rev` – pełny stan tylko po zmianie; radio co 2,5 s przyrostowo `?since=`). Bez WebSocketów – zgodne z Railway i prostsze w utrzymaniu.

## Zasada uprawnień
Uprawnienia efektywne = domyślne dla (frakcja, ranga) z `rbac_role_perms` **+ allow** z `rbac_user_grants` **− deny** z `rbac_user_grants`. Administrator systemu to konto z Discord ID w `MDT_ADMIN_DISCORD_IDS`.
Administrator zmienia macierz w zakładce *Administracja* (albo `/mdt uprawnienie` na Discordzie). Domyślna macierz jest zasiewana **raz** (marker `rbac_seed_v1`) – restart niczego nie przywraca.
Zasady dodatkowe: nie zmienisz własnej rangi/uprawnień/zawieszenia; tylko osoby niższej rangi; nadajesz tylko uprawnienia, które sam masz; `admin.system.manage` nie da się nadać z poziomu frakcji.

### Domyślna macierz
| Uprawnienie | LAPD PRA | LAPD ZAS | LAPD SZE | LAFD PRA | LAFD ZAS | LAFD SZE | EMS PRA | EMS ZAS | EMS SZE | DOT PRA | DOT ZAS | DOT SZE | DOJ PRA | DOJ ZAS | DOJ SZE |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `mdt.access` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `mdt.persons.read` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `mdt.vehicles.read` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `mdt.vehicles.manage` | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ | ✔ | ✔ |  |  |  |
| `mdt.warrants.read` | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  | ✔ | ✔ | ✔ |
| `mdt.warrants.create` | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |
| `mdt.warrants.manage` |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |
| `mdt.reports.create` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `mdt.reports.read` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `mdt.reports.manage` |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |
| `dispatch.access` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |
| `dispatch.calls.create` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |
| `dispatch.calls.manage` |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  |  |  |
| `dispatch.units.assign` |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  |  |  |
| `dispatch.calls.view_all` |  |  | ✔ |  |  | ✔ |  |  | ✔ |  |  | ✔ |  |  |  |
| `alarms.read` | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |
| `alarms.manage` |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |
| `radio.access` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `radio.channel.join` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `radio.interop` |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  |  | ✔ |
| `radio.command` |  |  | ✔ |  |  | ✔ |  |  | ✔ |  |  | ✔ |  |  | ✔ |
| `radio.channel.manage` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `faction.personnel.read` |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |
| `faction.personnel.manage` |  |  | ✔ |  |  | ✔ |  |  | ✔ |  |  | ✔ |  |  | ✔ |
| `faction.ranks.manage` |  |  | ✔ |  |  | ✔ |  |  | ✔ |  |  | ✔ |  |  | ✔ |
| `faction.treasury` |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  |  |  |
| `doj.cases.read` |  |  |  |  |  |  |  |  |  |  |  |  | ✔ | ✔ | ✔ |
| `doj.cases.manage` |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ | ✔ |
| `doj.cases.classified` |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ |
| `audit.read` |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |  | ✔ | ✔ |
| `admin.system.manage` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

(DOJ jest osobną frakcją; PD nie ma domyślnie dostępu do spraw DOJ i odwrotnie. Poufne sprawy: tylko `doj.cases.classified`.)

## Dispatch
- Statusy zgłoszeń: NOWE → PRZYJETE/PRZYDZIELONE → W_DRODZE → NA_MIEJSCU → W_TRAKCIE → ZAKONCZONE | ANULOWANE (tabela przejść po stronie serwera, `W_TRAKCIE` zostaje dla zgodności ze starym panelem).
- Zgłoszenie ma frakcję główną i `also_factions` (wspólna obsługa, np. napad → LAPD + EMS). Widoczność: główna lub dodatkowa; `dispatch.calls.view_all` – wszystkie.
- Jednostka = wiersz `faction_duty` (znak wywoławczy unikalny w frakcji, status). **Jedna jednostka – jedno aktywne zgłoszenie** (częściowy unikalny indeks `ticket_units_active_unit_uq` – konflikt przy równoległych przydziałach rozstrzyga baza).
- Zamknięcie/anulowanie zwalnia jednostki; zejście ze służby, zawieszenie i zdjęcie frakcji też.
- Stare panele (EMS/DOT/LAPD/LAFD w telefonie) widzą te same zgłoszenia; ich zapytania zostały rozszerzone o nowe statusy.

## Radio (tekstowe)
Kanały: DISPATCH, LAPD, LAFD, EMS, DOT, INTEROP (`radio.interop`), COMMAND (`radio.command`, ranga SZEF). Reguły kanału: dozwolone frakcje + minimalna ranga + wymagane uprawnienie (tabela `radio_channels`, edytowalna).
Nadawca jest **zawsze** brany z sesji (klient nie poda cudzej tożsamości); nadawać można tylko na służbie; limit 15 wiadomości/min; retencja 7 dni. PANIC → kanał frakcji + DISPATCH.

## Alarmy napadowe
- Punkt integracji dla przyszłego systemu napadów: `POST /internal/mdt/alarms` (`x-api-key`), pola: `idempotency_key` (**wymagane**), `location_key` (zweryfikowana lokalizacja) albo `location_text`, `kind`, `source`, `silent` (domyślnie true).
- Alarm cichy: `fire_at = teraz + ALARM_SILENT_DELAY_SECONDS` (domyślnie 90 s) liczone **na serwerze**; harmonogram (co 5 s, `FOR UPDATE SKIP LOCKED`) w jednej transakcji zmienia status, tworzy zgłoszenie P1 (LAPD + `ALARM_ALSO_FACTIONS`, domyślnie EMS) i komunikat radiowy. Ten sam `idempotency_key` nigdy nie utworzy drugiego alarmu ani zgłoszenia (UNIQUE + ON CONFLICT).
- Anulowanie w oknie opóźnienia: `POST /internal/mdt/alarms/:key/cancel`. System napadów **jeszcze nie istnieje** – to tylko gotowe złącze + ręczny/testowy alarm w tablecie i `/mdt alarm-test`.

## Ograniczenia ER:LC (świadome)
ER:LC nie udostępnia pozycji graczy ani automatycznych alarmów napadu. Dlatego: lokalizacja = zweryfikowane miejsce z listy `mdt_locations` albo tekst wpisany przez człowieka; **brak** automatycznego odczytu pozycji, GPS i mapy na żywo.

## Zmienne środowiskowe (API)
| Zmienna | Znaczenie | Domyślnie |
|---|---|---|
| `MDT_ADMIN_DISCORD_IDS` | Discord ID administratorów MDT (po przecinku) | puste |
| `ALARM_SILENT_DELAY_SECONDS` | opóźnienie alarmu cichego | 90 |
| `ALARM_ALSO_FACTIONS` | dodatkowe frakcje zgłoszenia alarmowego | EMS |
| `PHONE_FACTION_PANELS` | `off` chowa panele frakcji (EMS/DOT/LAPD/LAFD) w telefonie | on |
Bot główny: `DOJ_ROLE_ID`, `DOJ_BOSS_ROLE_ID`, `DOJ_DEPUTY_ROLE_ID` (jak dla pozostałych frakcji).

## Przeniesienie paneli z telefonu (bezpieczne, odwracalne)
Panele frakcji w telefonie są **nadal włączone** (`PHONE_FACTION_PANELS` domyślnie `on`), obok nich działa tablet. Gdy sprawdzisz tablet na żywo: ustaw `PHONE_FACTION_PANELS=off` – panele znikną z telefonu, kod i endpointy zostają (powrót = usunięcie zmiennej).

## Audyt
Tabela `faction_audit` (rozszerzona o `result`, `object_type`; frakcja `SYSTEM` dla zdarzeń globalnych). Zapisywane m.in.: służba, zgłoszenia, przydziały, zmiany rang/uprawnień/zawieszeń, raporty, poszukiwania, sprawy DOJ, alarmy, panic, **odmowy dostępu do raportów/spraw poufnych**, zmiany macierzy. Nie zawiera haseł ani tokenów.
