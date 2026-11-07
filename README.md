# GradeNext Auto-Post

One Google Apps Script file (`apps-script/Code.gs`) that posts GradeNext's approved videos to **Instagram**, **Facebook** and **YouTube** on its own, every day, with no person involved.

It runs free on Google's servers, every 5 minutes, 24/7.

---

## How it works

```
Inventory website ──(every 5 min)──► Apps Script ──► Instagram / Facebook / YouTube
  videos, captions, covers              1. read videos + approvals
  Dr. Shahid's approvals                2. give each approved video a slot
  Tasks (dates, platforms)              3. post what is due
        ▲                               4. find real posts, read views
        └──────── ticks, links, status, new dates ◄──┘
```

Each run (`runDue`) does these steps:

1. **Read** the website:
   - `ap/data.json`: videos, Drive file, cover, caption, series.
   - `/api/approve`: Dr. Shahid's decisions.
   - `/api/plan`: dates, platforms, caption edits, auto on/off, "Post now".
2. **Schedule** with the slot rule below, and write the new dates back to the website.
3. **Post** every video that is approved and due.
4. **Report** ticks, post links and status back to the website's Tasks tab.
5. **Check** the real Instagram and Facebook posts. A post made by hand is ticked too, so nothing is posted twice.
6. **Views**: once an hour, read the Instagram and Facebook views into the website's Analysis tab.

---

## The schedule rule (slots)

Every day has **2 slots**, in San Francisco time:

| Slot | Time | Which videos |
|---|---|---|
| A | 9:00 AM | Face videos: Main reel, Motivational, Dr. Shahid, YouTube long video |
| B | 6:30 PM | Website or Blog videos |

1. **Only approved videos get a slot.**
2. **Order:** whichever video is approved first gets the earliest free slot of its type. That is today's slot if its time is still ahead, otherwise tomorrow's, and so on.
3. **Never more than 2 videos a day:** one from slot A and one from slot B.
4. **Posted videos keep their day.** Their slot counts as used.
5. **Not approved when the time comes:** the video moves to the next day, same time, and it keeps moving each day until it is approved.
6. **No connected platform** (for example a YouTube-only video while YouTube is not connected): if it is approved, it keeps its day and slot and stays visible in Tasks; it is posted once that platform is connected (within 24 h).

The slot times are `SLOT_A` and `SLOT_B` at the top of the slots section in `Code.gs`.

---

## When it posts, and when it doesn't

A video is posted only when **all** of these are true:

- Dr. Shahid approved it (`/api/approve` status is `ok`).
- Its date and time (San Francisco) have arrived.
- Auto-post is on for it, and at least one of its platforms is connected and not yet posted.
- It has a cover image. Without a cover it is **never** posted.

It is **not** posted when any of these is true:

- It is more than **24 hours late**. Old videos are never posted by surprise; they show as `missed`.
- It is already posted on that platform, whether by this script or by hand.
- A platform failed 3 times. The video then shows as `failed` and an email alert is sent.

"Post now" in the website skips the wait and posts at once, but only if the video is approved.

Two more details:
- **Location** is always San Francisco / Bay Area. Instagram and Facebook use a fixed place ID; YouTube uses the recording location.
- **Safety:** only one run can work at a time (a lock), and every post is saved the moment it succeeds, so a run that gets cut off can never post twice.

---

## Setup (one time)

1. **Apps Script:** create a project and paste in `apps-script/Code.gs`.
2. **Script Properties** (Project Settings). Secrets live only here, never in the code:

| Property | What |
|---|---|
| `EDIT_PIN` | Website edit PIN (lets the script write dates, ticks and status back) |
| `META_USER_TOKEN` | Long-lived Meta user token. Run `setupMeta()` once: it makes a never-expiring Page token and removes this property |
| `META_PAGE_TOKEN`, `META_PAGE_ID`, `IG_USER_ID` | Filled in by `setupMeta()` |
| `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN` | YouTube. Until these exist, YouTube is skipped ("not connected yet") |
| `ALERT_MAIL` | Optional. Where failure emails go (default: the script owner) |

3. Run `setupTrigger()` once. This starts the 5-minute timer.

### Requirements

- **Meta:** a Meta developer app (Business type), with Instagram as a Business account linked to the Facebook Page. Permissions: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`. The developer account must stay **active**: if Meta locks it ("account confirmation needed"), every token stops working until the owner confirms the account.
- **Video files** in Google Drive. The script makes each file "anyone with the link" so Meta can download it.
- **The website**, which must provide `ap/data.json`, `/api/plan` and `/api/approve`. Change it with `SITE` in `Code.gs`.

---

## Tests (offline, with fake Google, Meta and YouTube services)

```
node test/run.js     # 28 checks: posting, timing, approval wait, retries, cover rule, YouTube pieces, ticks, views
node test/slots.js   # 16 checks: the 2-slot rule, approval order, move-to-tomorrow, max 2 a day, time zone
```

---

## Useful functions (run from the Apps Script editor)

| Function | Does |
|---|---|
| `runDue()` | One full run now (the timer calls it every 5 minutes) |
| `setupMeta()` | Turns `META_USER_TOKEN` into a permanent Page token |
| `checkViews()` | Reads views now and logs any Meta error |
| `resyncSite()` | Re-sends every status, tick and link to the website |
| `setupTrigger()` | Starts the 5-minute timer |
