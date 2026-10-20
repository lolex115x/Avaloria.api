# Migracje i rollback

Wszystkie migracje są idempotentne (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) i uruchamiają się przy starcie API (`mdt.migrate`). **Nic nie jest usuwane ani przepisywane** – stare dane i endpointy działają bez zmian.

## Zmiany w istniejących tabelach (tylko dodanie kolumn)
- `faction_members`: `suspended`, `suspended_reason`, `suspended_by`, `suspended_at`
- `faction_audit`: `result`, `object_type`
- `faction_duty`: `callsign`, `unit_status`, `status_note` (+ unikalny indeks znaku w frakcji)
- `tickets`: `priority`, `source`, `also_factions`, `alarm_id`

## Nowe tabele
`rbac_role_perms`, `rbac_user_grants`, `mdt_meta`, `ticket_units`, `mdt_rev`, `vehicles`, `mdt_warrants`, `mdt_reports`, `mdt_report_edits`, `doj_cases`, `doj_case_notes`, `doj_case_reports`, `radio_channels`, `radio_messages`, `mdt_locations`, `robbery_alarms` + wyzwalacze `mdt_bump_*`.

## Rollback (gdyby trzeba było cofnąć MDT w bazie)
Najpierw wdróż poprzednią wersję API (v14) – stary kod ignoruje nowe kolumny i tabele. Dopiero potem, jeśli chcesz posprzątać:
```sql
DROP TRIGGER IF EXISTS mdt_bump_tickets ON tickets;
DROP TRIGGER IF EXISTS mdt_bump_ticket_units ON ticket_units;
DROP TRIGGER IF EXISTS mdt_bump_faction_duty ON faction_duty;
DROP FUNCTION IF EXISTS mdt_bump();
DROP TABLE IF EXISTS doj_case_reports, doj_case_notes, doj_cases, mdt_report_edits, mdt_reports, mdt_warrants,
  vehicles, radio_messages, radio_channels, robbery_alarms, mdt_locations, ticket_units, mdt_rev,
  rbac_user_grants, rbac_role_perms, mdt_meta;
-- kolumn dodanych do istniejących tabel NIE usuwaj bez potrzeby (są nieszkodliwe); jeśli musisz:
-- ALTER TABLE faction_members DROP COLUMN suspended, DROP COLUMN suspended_reason, DROP COLUMN suspended_by, DROP COLUMN suspended_at;
```
Uwaga: stare zgłoszenia o nowych statusach (PRZYDZIELONE/W_DRODZE/NA_MIEJSCU) po cofnięciu kodu zamień na `W_TRAKCIE`:
`UPDATE tickets SET status='W_TRAKCIE' WHERE status IN ('PRZYDZIELONE','W_DRODZE','NA_MIEJSCU');`
