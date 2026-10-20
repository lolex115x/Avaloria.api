# Raport końcowy – Tablet MDT, Dispatch, Radio

## Audyt telefonu (Etap A)
**Zostaje w telefonie bez zmian:** Bank (przelewy, historia, faktury do zapłaty, krypto, kontrakty), Ćwierk, Wiadomości (+ czat Darkweb), Kontakty, Sklep, Plecak (+ przeszukanie/konfiskata), Ustawienia (rozmiar, postacie), połączenia (WebRTC), logowanie i zapamiętane postacie, aplikacja ???.
**Panele frakcji (`Panel EMS/DOT/LAPD/LAFD`) i ich odpowiedniki w tablecie:**

| Funkcja panelu w telefonie | Endpoint (bez zmian, dalej działa) | Odpowiednik w tablecie |
|---|---|---|
| Służba (wejście/wyjście, czas) | `/customer/factions/:f/ops/duty` | Pulpit + `/mdt/duty` (znak wywoławczy, statusy) |
| Lista/przyjmowanie/zamykanie zgłoszeń | `/ops/tickets*` | Dispatch (`/mdt/dispatch/*`) – te same rekordy `tickets` |
| Szczegóły holowania (DOT) | `/ops/tickets/:id/details` | **Zostaje w panelu telefonu** (patrz „Nie przeniesiono”) |
| Kartoteka medyczna EMS | `/ops/records*` | Zakładka „Kartoteka med.” (te same endpointy) |
| Faktury EMS/DOT | `/factions/:f/invoices*` | Zakładka „Faktury” (te same endpointy) |
| Skarbiec, wypłaty | `/factions/:f/treasury`, `/transfer` | Zakładka „Skarbiec” (te same endpointy) |
| Ludzie, rangi | `/ops/people`, `/ops/people/:cid/rank` | Personel (rangi, zawieszenia, uprawnienia) |
| Audyt | `/ops/audit` | Audyt |
| Zgłoszenia od obywateli (911/EMS/DOT z telefonu) | `/customer/dispatch/request` | Trafiają do tych samych zgłoszeń widocznych w Dispatchu |

## Co zrobiono
- **B** RBAC (frakcja + ranga + uprawnienia specjalne allow/deny), frakcja **DOJ**, zawieszenia, audyt, aktywna frakcja walidowana na serwerze, nawigacja zależna od uprawnień.
- **C/D** EMS i DOT w tablecie (dispatch, kartoteka, faktury, skarbiec), PD (osoby, pojazdy, poszukiwani, raporty, alarmy), LAFD (dispatch, raporty, radio).
- **E** DOJ: sprawy jawne/poufne, notatki, raporty udostępnione DOJ przez autora.
- **F** Dispatch Center: priorytety P1–P4, statusy jednostek, przydziały z ochroną przed konfliktem, wspólna obsługa kilku frakcji.
- **G** Radio tekstowe z regułami kanałów, panic.
- **H** Alarmy napadowe: złącze `/internal/mdt/alarms` z idempotencją, alarm cichy z opóźnieniem po stronie serwera, ręczny test. **System napadów jeszcze nie istnieje.**
- **I** Testy, dokumentacja (`docs/MDT.md`, `docs/MIGRACJE.md`), migracje z rollbackiem.

## Testy (uruchomione lokalnie: Postgres 16 + Node + headless Chromium)
| Zestaw | Skrypt | Wynik |
|---|---|---|
| RBAC, dostęp, służba, dispatch, konflikty jednostek, personel, zawieszenia, audyt, admin, regresja starych endpointów | `docs/testy/mdt1.py` | 58 asercji OK |
| Osoby, pojazdy, poszukiwani, raporty (+historia edycji), DOJ (jawne/poufne), radio (tożsamość z sesji, limit), alarmy (idempotencja, opóźnienie, anulowanie, 8 równoległych żądań = 1 alarm) | `docs/testy/mdt2.py` | 72 asercje OK |
| Tablet w przeglądarce: login, nawigacja wg uprawnień, zgłoszenie, przydział, radio, raport, EMS, odświeżenie sesji, wylogowanie nie rusza telefonu, widok mobilny, brak błędów JS | `docs/testy/mdtui.py` | 15 OK |
| Telefon: wszystkie aplikacje zostają, ikona Tablet MDT, skrót SSO, flaga `PHONE_FACTION_PANELS` on/off, legacy endpointy przy fladze off | `docs/testy/mdt3.py` | OK |
| Tablet w przeglądarce, pełny przegląd: PANIC, alarmy, radio (Command), pojazdy, poszukiwani, osoby, raporty (edycja, historia, udostępnianie DOJ), personel (rangi, zawieszenia, uprawnienia), skarbiec, audyt, DOJ, EMS (kartoteka, faktura), admin, wąski ekran | `docs/testy/mdtui2.py` | 31 OK |
| Osobna aplikacja: manifest `/mdt/`, ikony, service worker (zakres `/mdt/`, API nieprzechwytywane), brak błędów instalowalności, telefon ma własny manifest | `docs/testy/pwa.py` | OK |
| Program desktopowy Electron (pod Xvfb): ładowanie, logowanie, izolacja od Node, obce linki, zapamiętana sesja po zamknięciu, F5, start przy wyłączonym serwerze | `docs/testy/electron_test.py` | OK |
| Regresja plecaka | `docs/testy/bp2.py` | 23 OK |
Skrypty wymagają lokalnego API na porcie 3056 (`INTERNAL_API_KEY=k`, `MDT_ADMIN_DISCORD_IDS=999`, `ALARM_SILENT_DELAY_SECONDS=3`) i Postgresa; to skrypty referencyjne, nie część wdrożenia.

## NIE sprawdzone na żywo
Railway, Discord (`/mdt`, `/frakcja … DOJ`), prawdziwe role Discorda (DOJ), Electron, wielu graczy jednocześnie, wydajność pod obciążeniem, uprawnienia na realnych danych. Testy nie obejmują przycisku PANIC w przeglądarce ani edytora raportu w UI poza utworzeniem.

## Nie przeniesiono / zgłoszone problemy
1. **Szczegóły holowania DOT** (tablica, pojazd, miejsce odholowania, czynności) nie mają jeszcze formularza w tablecie – dlatego panele w telefonie **nie zostały ukryte domyślnie** (`PHONE_FACTION_PANELS=on`). Odpowiednik do dodania w następnej iteracji (endpoint `/ops/tickets/:id/details` działa).
2. Rangi z MDT są nadpisywane przy najbliższej synchronizacji ról Discorda (to założenie projektu: Discord = źródło prawdy).
3. Brak mapy i pozycji graczy (ograniczenie ER:LC). Brak konfiguracji zweryfikowanych lokalizacji poza ręcznym dodaniem w zakładce Alarmy.
4. Pełny Etap „usunięcie paneli z telefonu” wymaga Twojej decyzji po sprawdzeniu tabletu na żywo (jedna zmienna środowiskowa).
5. Tekst załącznika ze specyfikacją urwał się na punkcie 20 – punkty od 20 w górę mogą nie być uwzględnione.

## Wdrożenie
1. API: wgraj `1-API-v15.zip` (nadpisz pliki, w tym katalogi `mdt/`, `public/mdt/`, `docs/`), ustaw `MDT_ADMIN_DISCORD_IDS` (Twoje Discord ID). Restart – migracje ruszą same.
2. Bot główny: `3-GLOWNY-BOT-v7.zip` (`erlc-commands.js`, `faction-sync.js`), ustaw `DOJ_ROLE_ID`, `DOJ_BOSS_ROLE_ID`, `DOJ_DEPUTY_ROLE_ID`, zrestartuj (rejestracja `/mdt`).
3. Otwórz `https://<twoje-api>/mdt/` lub ikonę „Tablet MDT” w telefonie.
