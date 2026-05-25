# tasks

Task lists on your Solid pod. Optional (install from the store), not a default app.

Same functionality as the SolidOS todo — **multiple lists**, add / complete /
edit / delete, **filter** (All / Active / Done), and **Move to…** a task between
lists — plus **Import** lists from another pod (normalizes both the losos
`schema:ItemList` and `wf:Tracker` shapes; public, reachable sources) — with a
purple skin, built on the **`wf:Tracker` data model** so it
**interoperates with [pilot](https://github.com/solid-apps/pilot)** and your
existing trackers (not a new silo).

## Data model

One JSON-LD file per list under `<pod>/public/tracker/`, in the SolidOS
tracker shape (the same one pilot writes):

```jsonc
{ "@context": { "wf":"…wf/flow#", "ical":"…cal/ical#", "dct":"…dc/terms/",
    "summary":"ical:summary", "status":"ical:status", "title":"dct:title",
    "issue":"wf:issue", "Tracker":"wf:Tracker", "Vtodo":"ical:Vtodo" },
  "@id":"#this", "@type":"Tracker", "title":"My list", "initialState":"NEEDS-ACTION",
  "issue": [ { "@id":"#Iss…", "@type":"Vtodo", "summary":"a task",
               "status":"NEEDS-ACTION"|"COMPLETED", "created":"…", "modified":"…" } ] }
```

## Notes

- v1 discovers lists by listing `/public/tracker/`. Registering newly-created
  lists in the **public type index** (so pilot discovers them too) is the next
  step — pilot already writes here, so tasks sees pilot's lists today.
- Reads/writes use `window.xlogin.authFetch`; sign in (login pill) to edit.

## License

AGPL-3.0-only.
