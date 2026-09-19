# QUALITY_GATE.md — בקרת איכות קשוחה

> **למי הקובץ הזה מיועד:** לסוכן AI שהתבקש לבצע "בקרת איכות" / "QA" / "בדיקת פערים" על הפרויקט.
> קרא את הקובץ **במלואו** לפני שאתה מתחיל, ובצע את הבדיקות **לפי הסדר**.

---

## 0. כללי ברזל

1. **אין "ירוק" בלי ראיה.** כל בדיקה חייבת פלט אמיתי של פקודה שהרצת בפועל. אסור לסמן `PASS` על סמך קריאת קוד, זיכרון, או הנחה.
2. **אסור לתקן תוך כדי בקרה** אלא אם המשתמש ביקש במפורש. קודם דו"ח מלא, אחר כך תיקונים.
3. **בדיקה שלא ניתן להריץ = `BLOCKED`, לא `PASS`.** אם חסרה תלות, סביבה, או מפתח — זה ממצא בפני עצמו, לא פטור.
4. **טסט שמדלג על עצמו = `FAIL`.** חבילת טסטים שמסיימת ב"ok" בזמן שהיא ביצעה `return` מוקדם היא כיסוי מדומה.
5. **תמיד הרץ את שלושת התתי־פרויקטים.** frontend (`/`), Worker (`chordsync-api/`), Rust+sidecar (`src-tauri/`). פער נפוץ הוא בגבול ביניהם, לא בתוכם.
6. **הפרד "מתקמפל" מ"עובד".** הפרויקט הזה עבר build ו־26 טסטים ירוקים בזמן שלוש תקלות ריצה שוברות פיצ'רים. `tsc` ו־`cargo check` הם תנאי סף, לא הוכחה.
7. **בדוק את מצב הריצה בפועל על הפלטפורמה הנוכחית** (Linux/Fedora), לא רק את מה שנתמך תיאורטית.
8. אין להסתמך על סעיף 8 (מרשם תקלות פתוחות) כאילו הוא עדכני — **אמת כל פריט מחדש** בכל הרצה, וסמן אם השתנה.

---

## 1. שערים חוסמים (Blocking Gates)

כישלון באחד מאלה = הגרסה **לא כשירה**. עצור, דווח, אל תמשיך לסעיפים הבאים לפני שדיווחת.

| # | שער | פקודה | תנאי מעבר |
|---|-----|-------|-----------|
| G1 | Type-check frontend | `npx tsc -b --force` | exit 0, אפס שגיאות |
| G2 | Build frontend | `npx vite build` | exit 0, נוצר `dist/index.html` + `dist/assets/*.js` |
| G3 | Type-check Worker | `cd chordsync-api && npx tsc --noEmit` | exit 0 |
| G4 | טסטי Worker | `cd chordsync-api && npx vitest run` | כל הטסטים עוברים, **אפס** `skipped` |
| G5 | קומפילציית Rust | `cd src-tauri && cargo check --all-targets` | exit 0, אפס warnings חדשים |
| G6 | טסטי Rust | `cd src-tauri && cargo test` | כל הטסטים עוברים |
| G7 | **עקביות אריזה** | ראה §3.1 | `frontendDist` מצביע על תיקיית הפלט האמיתית של Vite |
| G8 | **עקביות ACL** | ראה §3.2 | כל פקודה ב־`invoke_handler` מותרת ב־capabilities |

---

## 2. בדיקות לפי תת־מערכת

### 2.1 Frontend (React + Vite)

- [ ] `npx tsc -b --force` — exit 0. (אם משתמשים ב־cache, הרץ עם `--force`; בלי זה `tsc -b` יכול להחזיר 0 בלי לבדוק כלום.)
- [ ] `npx vite build` — exit 0.
- [ ] גודל bundle: אם ה־chunk הראשי חצה **500KB לא־דחוס**, דווח כרגרסיה עם המספר הקודם.
- [ ] אין `console.log` שנשאר בקוד ייצור. `console.warn`/`console.error` מותרים רק בנתיבי כישלון מפורשים.
- [ ] **כל `catch` שבולע שגיאה חייב הצדקה.** ספציפית: `catch` שרק כותב ל־console ולא משנה state נראה למשתמש הוא חשוד — ודא שהכישלון באמת לא־קריטי. (זו בדיוק הצורה שהסתירה את תקלת ה־ACL.)
- [ ] כיסוי טסטים: הרץ `find src -name "*.test.*" -o -name "*.spec.*" | wc -l`. אם `0` — סמן `FAIL` על כיסוי, גם אם ה־build ירוק. ציין כמה שורות לוגיקה לא־מכוסות (`wc -l src/chords/*.ts src/services/*.ts src/scaleSpell.ts`).
- [ ] ודא שקיים `test` script ב־`package.json`. אם אין — `FAIL`.

### 2.2 Worker (Cloudflare / chordsync-api)

- [ ] `npx tsc --noEmit` — exit 0.
- [ ] `npx vitest run` — הכל עובר. **ספור טסטים מדולגים; כל דילוג הוא ממצא.**
- [ ] הפרד בדו"ח בין טסטים **hermetic** (רצים לא־מקוונים) לבין טסטים שתלויים ברשת חיה. טסט תלוי־רשת אינו רגרסיה אמינה — ציין אותו במפורש.
- [ ] `compatibility_date` ב־`wrangler.jsonc` לא מקדים את ה־runtime המותקן. אם ה־build מדפיס `Falling back to "..."` — זה ממצא.
- [ ] כל binding שהקוד קורא לו קיים ב־`.dev.vars.example`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SECRET`. חוסר = `FAIL`.
- [ ] **בדיקת חיים של הפריסה** (ראה §3.3) — לא מספיק שהקוד תקין; ה־Worker צריך לענות.

### 2.3 Rust / Tauri

- [ ] `cargo check --all-targets` — exit 0.
- [ ] `cargo test` — הכל עובר.
- [ ] `cargo clippy --all-targets -- -D warnings` — אם clippy מותקן. אם לא, `BLOCKED` (לא `PASS`).
- [ ] `cargo fmt --check` — אם נכשל, זה ממצא בדרגה נמוכה.
- [ ] **טסטים מותנים־סביבה:** הרץ `cargo test -- --ignored --nocapture` (ה־fixtures מסומנים `#[ignore]` ולא מדלגים על עצמם בשקט). `cargo test` רגיל חייב לדווח `1 ignored` — אם הוא מדווח `ok` בלי להריץ, זה `FAIL` על כיסוי.
- [ ] אין `unwrap()`/`expect()` בנתיב ריצה שתלוי בקלט חיצוני (audio, IPC, sidecar stdout). ב־`main`/setup זה מקובל.
- [ ] כיסוי פלטפורמות: לכל `#[cfg(windows)]` בדוק שקיים מקבילה `#[cfg(target_os = "linux")]` או `#[cfg(not(any(...)))]` שמחזירה שגיאה מפורשת ולא panic.

### 2.4 Python sidecar (key_analyzer)

- [ ] **בדיקת ready אמיתית:**
  ```bash
  cd src-tauri && echo '' | timeout 30 python3 sidecars/key_analyzer/key_analyzer.py --serve
  ```
  קרא את שורת ה־ready. **`"ready": true` בזמן שכל ה־backends `false` הוא באג, לא מצב תקין.** `ready` חייב לשקף יכולת ניתוח בפועל.
- [ ] **בדיקת ניתוח אמיתי בשני המצבים:**
  ```bash
  REQ='{"sampleRateHz":44100,"windowSeconds":12,"hopSeconds":4,"profileTypes":["bgate"],"samplesMonoF32":[0.0,0.1,0.2]}'
  printf "%s\n" "$REQ" | timeout 30 python3 sidecars/key_analyzer/key_analyzer.py --serve
  printf "%s\n"  "$REQ" | timeout 30 python3 sidecars/key_analyzer/key_analyzer.py --analyze
  ```
  **תנאי מעבר קשוח:** בשני המצבים הפלט חייב להיות JSON תקין על stdout. **Traceback של Python = `FAIL`**, גם כשהתלויות חסרות. כשל חייב לחזור כ־`{"windows": [], "error": "<reason>"}`.
- [ ] זמינות backends: `python3 -c "import numpy, scipy"` ו־`import essentia` / `import librosa`. חוסר = דווח כ`sidecar לא־תפקודי בסביבה הנוכחית` — לא כ"סביבה חסרה".
- [ ] אם ה־sidecar לא־תפקודי: **ציין מפורשות שזיהוי המפתח המקומי לא עובד בגרסה הזאת**, כי `apply_gate` חוסם fallback של numpy (ראה הטסט `apply_gate_blocks_numpy_fallback_even_when_stable`).
- [ ] backend `libkeyfinder`: זו **ברירת המחדל** ב־`key_engine.rs`. ודא שיש דרך לבנות את `sidecars/libkeyfinder_cli/main.cpp` (CMakeLists / Makefile / סקריפט). אם אין — `FAIL`: ברירת המחדל תמיד נופלת ל־fallback עם warning.

---

## 3. חוזי גבול (Cross-Boundary Contracts) — כאן נמצאים רוב הפערים

אלה הבדיקות שהכי חשוב להריץ, כי כל צד עובר לבד ורק החיבור שבור.

### 3.1 Vite outDir ↔ Tauri frontendDist
```bash
grep -n "outDir" vite.config.ts || echo "outDir לא מוגדר → ברירת מחדל: dist"
grep -n "frontendDist" src-tauri/tauri.conf.json
ls -d dist build 2>&1
```
**תנאי מעבר:** `frontendDist` מצביע על תיקייה שקיימת **אחרי** `vite build`. אי־התאמה = `tauri build` נכשל = שער חוסם.

### 3.2 invoke_handler ↔ capabilities ↔ permissions ↔ קריאות frontend
```bash
# פקודות רשומות ב-Rust
sed -n '/generate_handler!/,/]/p' src-tauri/src/lib.rs
# פקודות מותרות ב-ACL
cat src-tauri/capabilities/default.json
ls src-tauri/permissions/
# פקודות שה-frontend באמת קורא להן
grep -rhno "invoke<[^>]*>('[^']*'" src/ | sed "s/.*('//;s/'//"
```
**תנאי מעבר (כל השלושה):**
1. כל פקודה ב־`generate_handler!` יש לה קובץ `permissions/allow-<name>.toml`.
2. כל הרשאה כזאת מופיעה במערך `permissions` ב־`capabilities/default.json`.
3. כל `invoke('X')` ב־frontend — `X` מותרת.

פקודה רשומה־אך־לא־מותרת שה־frontend קורא לה = **תקלה שוברת פיצ'ר**, גם אם היא "נכשלת בשקט".

### 3.3 Frontend ↔ Worker (endpoints + זמינות)
```bash
grep -n "url.pathname" chordsync-api/src/index.ts        # מה ה-Worker מגיש
grep -rn "new URL('\|currentApiBase()}" src/services/songKeyApi.ts   # לאן ה-frontend פונה
BASE=$(grep -oP "DEFAULT_API_BASE = '\K[^']+" src/services/songKeyApi.ts)
curl -s -m 25 -o /dev/null -w "%{http_code}\n" "$BASE/lookup-song?title=Numb&artist=Linkin+Park"
curl -s -m 25 "$BASE/lookup-song?title=Numb&artist=Linkin+Park" | head -c 300
```
**תנאי מעבר:** כל נתיב שה־frontend פונה אליו קיים ב־Worker, **ו**־ה־base URL של ברירת המחדל מחזיר תשובה תקינה. שגיאת Cloudflare (`error code: 1016`, `1033`, `52x`) = הפריסה מתה = `FAIL`, גם אם הקוד מושלם.

### 3.4 אירועי Tauri (emit ↔ listen)
```bash
grep -rhno 'emit[_a-z]*("[^"]*"' src-tauri/src/ | sed 's/.*("//;s/"//' | sort -u
grep -rhno "listen[^(]*('[^']*'" src/ | sed "s/.*('//;s/'//" | sort -u
```
**תנאי מעבר:** שתי הרשימות זהות. שם שנפלט ואף אחד לא מאזין לו = קוד מת. שם שמאזינים לו ואף אחד לא פולט = פיצ'ר שבור.
ידועים כרגע: `detected-key-update`, `detected-key-ab-update`, `media-session-update`.

### 3.5 טיפוסי wire (Rust struct ↔ TS type)
לכל payload שעובר ב־IPC (`DetectedKeyPayload`, `MediaSessionWire`, `CloudResolutionControl`):
- [ ] שמות השדות תואמים, כולל `#[serde(rename_all = ...)]` מול הטיפוס ב־TS.
- [ ] שדות `Option<T>` ב־Rust הם `| null` ב־TS.
- [ ] שדה שנוסף בצד אחד ולא בשני = ממצא.

### 3.6 משתני סביבה
```bash
grep -rho 'env::var("[^"]*"' src-tauri/src/ | sed 's/.*("//;s/"//' | sort -u
```
**תנאי מעבר:** כל משתנה מתועד (ב־`dev.ps1`, README, או `.dev.vars.example`), ולכל אחד יש ברירת מחדל שפויה **לפלטפורמה הנוכחית**. ברירת מחדל של Windows בלבד (למשל `"py"`) בקוד שרץ על Linux = ממצא.

---

## 4. התנהגות בתנאים מחמירים (Degradation)

הפרויקט הזה בנוי משכבות שיכולות ליפול בנפרד. לכל תרחיש: **מה המשתמש רואה?** תשובה "כלום / קופא / שגיאה בקונסול" = `FAIL`.

| תרחיש | דרך אימות | התנהגות נדרשת |
|-------|-----------|----------------|
| sidecar חסר לגמרי | `KEY_ANALYZER_SIDECAR=/nonexistent` | סטטוס `analyzer_unavailable` גלוי ב־UI, בלי קריסה |
| sidecar קיים אבל בלי תלויות | הסביבה הנוכחית | הודעה מפורשת למשתמש, לא `ready:true` שקרי |
| sidecar קורס באמצע | הרג התהליך | restart מבוקר, בלי לולאת restart הדוקה (יש burst-limit — ודא שהוא באמת חוסם) |
| Worker לא זמין | חסום את ה־host / base URL שגוי | נפילה ל־catalogs בצד־לקוח, ואם גם הם נכשלים — מצב `miss` ולא `error` תקוע |
| catalogs בלי מפתחות API | localStorage ריק (ברירת מחדל) | דילוג שקט על הספק, לא כישלון של כל השרשרת |
| אין סשן מדיה פעיל | סגור נגנים | מצב `no_session` נקי |
| השהיה / דילוג בין שירים | הפעל/השהה, החלף שיר | איפוס state; אין הדלפת מפתח מהשיר הקודם |
| כותרת/אמן ריקים או ג'יבריש | metadata מזויף | `miss` נקי, לא חיפוש אינסופי |
| אין רשת בכלל | offline | האפליקציה נטענת ומגיבה; זיהוי מקומי בלבד |
| PulseAudio לא רץ (Linux) | `systemctl --user stop pipewire-pulse` | `audio_capture` מדווח `unavailable`, לא panic |
| הרצה מ־cwd אחר | `cd /tmp && <binary>` | resolution של sidecar לא נשען על cwd יחסי |
| אפליקציה ארוזה | `tauri build` + הרצת התוצר | ה־sidecar נמצא. דורש `externalBin`/`resources` ב־`tauri.conf.json` |

---

## 5. אריזה ופרודקשן

- [ ] `frontendDist` תקין (§3.1).
- [ ] `identifier` ב־`tauri.conf.json` אינו placeholder. `com.tauri.dev` = `FAIL`.
- [ ] `Cargo.toml`: `description` ו־`authors` אינם `"A Tauri App"` / `["you"]`.
- [ ] `productName` וכותרת החלון הם שם המוצר האמיתי.
- [ ] גודל חלון ברירת מחדל מתאים לתוכן בפועל (לא 800x600 גנרי אם ה־UI צפוף).
- [ ] `bundle.icon` — כל הקבצים ברשימה קיימים על הדיסק.
- [ ] ה־sidecar נארז: קיים `externalBin` או `resources` ב־`tauri.conf.json`. אם אין — האפליקציה הארוזה לא תמצא את האנלייזר = `FAIL`.
- [ ] `security.csp` — `null` פותח הכל. אם המוצר מיועד להפצה, זה ממצא.
- [ ] אין artifacts של build ב־git: `git ls-files | grep -iE "tsbuildinfo|^dist/|^build/|target/"` חייב להיות ריק.
- [ ] `git status` נקי בסוף הבקרה (חוץ משינויים שהמשתמש ביקש).

---

## 6. תשתית ותהליך

- [ ] קיים CI (`.github/workflows/`) שמריץ את **כל** שערי §1. אם אין — `FAIL`, וציין שכל הבדיקות כאן ידניות בלבד.
- [ ] סקריפטים לפיתוח קיימים לפלטפורמה הנוכחית. `dev.ps1` הוא PowerShell — על Linux/macOS זה `BLOCKED` עד שיהיה מקבילה.
- [ ] קיים README/CLAUDE.md שמסביר איך להריץ. אם אין — ממצא.
- [ ] `npx update-browserslist-db@latest` — אם ה־build מתלונן על caniuse ישן, זה ממצא בדרגה נמוכה.

---

## 7. פורמט הדו"ח

דווח **בעברית**, בסדר הזה, בלי לרכך:

1. **פסק דין:** `כשיר` / `כשיר עם הסתייגויות` / `לא כשיר`. שער חוסם שנכשל ⇒ `לא כשיר`.
2. **טבלת שערים** (§1) עם `PASS`/`FAIL`/`BLOCKED` לכל אחד.
3. **ממצאים לפי חומרה:** קריטי → משמעותי → איכות. לכל ממצא:
   - `file:line`
   - מה שבור בפועל (לא "עלול")
   - **תרחיש כשל קונקרטי:** קלט/מצב → תוצאה שגויה
   - הראיה שהרצת (הפקודה + הפלט)
4. **מה נבדק ועבר** — משפט אחד, בלי לנפח.
5. **מה לא הצלחת לבדוק ולמה** — חובה. אל תשמיט בדיקה חסומה בשקט.

**אסור:** לסמן `PASS` בלי פלט. לכתוב "נראה תקין" על סמך קריאת קוד. לדלג על §3 כי §1 עבר. לרכך ממצא כדי שהדו"ח ייראה טוב.

---

## 8. מרשם תקלות פתוחות (נכון ל־2026-09-10, אחרי סבב תיקונים)

**אמת כל פריט מחדש בכל הרצה.** אם תוקן — סמן `תוקן` ועדכן. אם עדיין קיים — סמן `רגרסיה נמשכת`.

### תוקן בסבב הזה
1. ✅ `src-tauri/tauri.conf.json` — `frontendDist` שונה ל־`../dist`. אומת: `vite build` יוצר `dist/index.html`, ובדיקת G7 ב־CI נכשלת אם זה יסטה שוב.
2. ✅ ACL — נוצרו `permissions/allow-set-cloud-resolution.toml`, `allow-get-cloud-resolution.toml`, `allow-get-media-sessions-debug.toml` וכולן נוספו ל־`capabilities/default.json`. job `acl` ב־CI מאמת את שלושת התנאים של §3.2; אומת מקומית שהוא נכשל כשמסירים הרשאה.
4. ✅ `key_analyzer.py` — `--analyze` עטוף ב־try/except ומחזיר `{"windows": [], "error": ...}` במקום Traceback; `ready` מחושב מ־`essentia or numpy` ולא קבוע `true`, עם `readyReason`. `key_detection.rs` מציף את `readyReason` למשתמש.
6. ✅ `sidecars/libkeyfinder_cli/` — נוספו `CMakeLists.txt` ו־`build.sh`. `build_libkeyfinder_detector()` מאתר את `build/gsv-libkeyfinder-cli` לבד, כך שברירת המחדל עובדת בלי export ידני.
7. ✅ `tauri.conf.json` — נוסף `bundle.resources` עם ה־sidecar; resolution של ה־sidecar כבר לא תלוי־cwd (`analyzer_search_roots()` נשען על `current_exe()`), עם טסטים ב־`key_engine::tests`.
8. ✅ `key_fixture_regression_test.rs` — ה־`return` המוקדם הוחלף ב־`#[ignore]`, כך ש־`cargo test` מדווח `1 ignored` במקום `ok` מדומה. `resolve_sidecar_python()` בוחר `python3` מחוץ ל־Windows.
9. ✅ frontend — נוספו 53 טסטים (`vitest`) ו־`test`/`test:watch`/`typecheck` scripts.
10. ✅ CI — נוסף `.github/workflows/ci.yml` המריץ את כל שערי §1 ובנוסף §3.1, §3.2, §3.4 ואת חוזה ה־JSON של ה־sidecar.
11. ✅ metadata — `identifier: com.yaliby.guitarscaleviewer`, `productName`/כותרת "Guitar Scale Viewer", חלון 1280x860 (min 900x640), `description`/`authors` אמיתיים, `security.csp` אמיתי במקום `null`.
12. ✅ `dev.ps1` היה Windows בלבד — נוסף `dev.sh` שקול ל־Linux/macOS. (היה פריט 5.)
13. ✅ `compatibility_date` ב־`wrangler.jsonc` הוקדם ל־`2026-03-10`; אזהרת `Falling back to ...` נעלמה.
14. ✅ clippy נקי תחת `-D warnings`, `cargo fmt --check` נקי, אזהרת browserslist נפתרה.
15. ✅ אין README — נוסף `README.md`.

### באגים שנמצאו בזכות הטסטים החדשים ותוקנו
16. ✅ `src/services/keyParse.ts` — `parseSpotifyStyleKey('Bb', 'minor')` החזיר `null`, כי `parseKeyAndMode` דורש mode ולא מזהה טוניקה בודדת. כל ספק שמחזיר key ו־mode בשדות נפרדים (reccobeats, musiciwant — `catalogKeyLookup.ts:241,252`, שם אין fallback) נפל ל־miss מלא. נוסף `parseTonic()`.
17. ✅ `src/scaleSpell.ts` — `pitchClassForNoteLabel` לא ידע לקרוא `Cb`/`Fb` ש־`buildScaleNotes` מייצר לגיטימית (Eb minor / phrygian / locrian). נוספו לטבלה גם `E#`/`B#`. (הפונקציה עדיין ללא קוראים בקוד — היה פער חוזה, לא שבירת פיצ'ר חי.)
18. ✅ `src/chords/scaleChordTheory.ts` — `chordLabels` הכיל את סמל האקורד במקום שמות התווים שהטיפוס מתעד. אין קוראים כרגע; תוקן כדי שהחוזה יהיה נכון.

### סבב פרונט 2026-09-11 — באגי זמן ריצה (תוקנו)
19. ✅ `src/hooks/useCloudKeyResolution.ts` — האפקט היה תלוי באובייקט `media` עצמו. ה־poller ב־`media_session.rs:671` פולט `media-session-update` כל 1.5 שניות עם `position_ms` חדש, כך שכל טיק ביטל (`ac.abort()`) והתחיל מחדש את החיפוש: `resolutionState` נתקע ב־`cloud_lookup` לנצח והקטלוגים הופגזו בבקשה כל 1.5s. האפקט תלוי עכשיו בפרימיטיבים מ־`buildLookupInputs()`. מכוסה ב־`useCloudKeyResolution.test.tsx` (נכשל לפני התיקון עם 4 חיפושים במקום 1).
20. ✅ `src/services/catalogKeyLookup.ts` — `getJson` בלע גם ביטול של הקורא והחזיר `null`, כלומר "אין מפתח לשיר". השהיה באמצע חיפוש הייתה מקבעת `miss` שגוי ל־5 דקות בקאש. ביטול חיצוני נזרק הלאה, ו־signal שכבר בוטל נבדק מראש (מאזין `abort` לא נורה עבורו) כדי לא להמשיך לספק הבא.
21. ✅ `src/hooks/useCloudKeyResolution.ts` — `musical_key.toUpperCase()` הפך `Bb` ל־`BB`. שורה מאומתת ב־Supabase עם מפתח בסימון במול הייתה משאירה את הצוואר על המפתח הקודם בשקט. הנרמול עבר ל־`normalizeLookupKey()` (`songKeyApi.ts`), מפתח שלא ניתן לפענוח נחשב `miss`. אותו באג תוקן ב־`submitSongKeySuggestion`.
22. ✅ לוגים — 11 קריאות `console.info` בנתיב הייצור הוחלפו ב־`debugLog()` (`src/services/debugLog.ts`): פעיל ב־dev, ובבילד ארוז רק עם `localStorage.gsv_debug_log = '1'`. `console.warn` נשאר בנתיבי כישלון בלבד.
23. ✅ כיסוי — נוספו טסטי jsdom (`@testing-library/react` + `jsdom` כ־devDependencies): `App.test.tsx` מוודא שהעץ באמת עולה, ו־`useCloudKeyResolution.test.tsx` מכסה את גבול media↔lookup. סה"כ 66 טסטים. בנוסף `Fretboard` ו־`ChordLibrarySection` עטופים ב־`memo` כדי שטיק המדיה לא ירנדר מחדש את כל הצוואר.

### סבב שימושיות 2026-09-12 — מדידות וכשלים שנמצאו בהרצה אמיתית

24. ✅ `dev.sh` — השער בדק מוכנות רק מול סיידקאר הפייתון, בזמן ש־Rust מריץ את `libkeyfinder` כברירת מחדל. במכונה בלי numpy זה סירב להפעיל (`exit 2`) למרות ש־CLI בנוי ועובד. השער בודק עכשיו את **הבקאנד שייבחר בפועל**, עם probe אמיתי (`exit 3` = `open_failed`, כלומר הבינארי נטען וה־.so נפתרו), ונופל ל־python רק כ־fallback מוצהר שגם מכריח `KEY_ANALYZER_BACKEND=current`. אומת בשלושת המסלולים.
25. ✅ פורט dev — `1420` היה מקודד קשיח גם ב־`vite.config.ts` וגם ב־`tauri.conf.json:devUrl`. פורט תפוס גרם ל־`strictPort` להפיל את ההפעלה, והתרחיש המסוכן יותר הוא webview שנטען משרת ישן ששרד בפורט. `dev.sh` בוחר עכשיו פורט פנוי אחד (1420–1460) ומעביר אותו לשניהם דרך `GSV_DEV_PORT` ו־`tauri dev --config`.
26. ✅ **דגל `ambiguous` היה מנותק.** הרוסט חישב אותו (`key_engine.rs:822-832`) והפרונט התעלם: `ambiguous` הופיע רק בנורית סטטוס וב־DevDrawer. מסלול `relative_pair_unresolved` מדליק את הדגל **בלי להוריד confidence**, ולכן payload עם `confidence: 0.88` ו־`ambiguous: true` עבר סף של 85% והזיז את הצוואר דווקא במקרה שהמנוע כבר לא בטח בו.
27. ✅ **פגיעת קטלוג קיבלה 100% ביטחון קבוע** (`GuitarScaleView.tsx:152`, `cloudHit ? 100 : ...`), וגברה על ניתוח מקומי בכל סף. `key`/`mode` של הקטלוגים הם הערכה אלגוריתמית בעצמה, לא תמלול. הלוגיקה עברה ל־`src/services/applyConfidence.ts` לפי מקור: מאומת=100, קטלוג לא מאומת=70 (מתחת לברירת המחדל 85), מקומי=הביטחון שלו, מקומי מעורפל=0. 12 טסטים.
28. ✅ נוסף כפתור `Relative` — החלפה בין מז'ור למינור יחסי (`relativeKey()` ב־`scaleSpell.ts`). זה הכשל הנמדד הנפוץ ביותר, ובו הצוואר כבר מצייר את התווים הנכונים ורק השורש והדרגות על הדרגה הלא נכונה.

### מדידות דיוק (2026-09-12) — לא באגים, מצב אמיתי

- **מנוע מקומי מול הפיקסצ'רים של הפרויקט:** 2/6 מדויקים. `guitar_rock_intro_then_hook` ו־`relative_pair_ground_truth_e_minor` — שנבנו במיוחד לתפוס הטיית דומיננטה ובלבול יחסיים — שניהם החזירו G major במקום E minor. `edm_mixed_excerpt` הוא MISS מלא (`expectedAmbiguous: false`). נמדד בקריאה ישירה ל־CLI, בלי שכבת הקונצנזוס.
- **קטלוגים מול שירים עם מפתח ידוע:** ~1/7 נכון (Hotel California → D major במקום B minor; Billie Jean → B minor במקום F# minor, בשלוש רשומות נפרדות). כיסוי עברית: 0/2.
- מסקנה: אין כרגע מקור אמת במערכת. `chordsync-api` + Supabase הוא המקום שנועד להיות אחד — ולכן פריט 3 (Worker לא פרוס) הוא הפער המרכזי, לא צדדי.

### פתוח — חוסם
3. ❌ **`src/services/songKeyApi.ts:7` — `DEFAULT_API_BASE` עדיין מחזיר Cloudflare `error code: 1016` (HTTP 500). ה־Worker לא פרוס.** זו תקלת תשתית, לא קוד: הקוד עצמו מתדרדר נכון (`lookupOwnDatabase` מחזיר `network_error` על כל תשובה לא־`ok` והשרשרת נופלת ל־catalogs בצד־לקוח ואז ל־miss נקי). מאומת ב־`src/services/songKeyApi.test.ts`. דורש `cd chordsync-api && npm run deploy` עם credentials.

### פתוח — חסום סביבתית (לא ניתן לאמת כאן)
- `python3 -c "import numpy"` נכשל בסביבה הזאת ⇒ **זיהוי מפתח מקומי לא עובד בגרסה שרצה כאן**. ה־sidecar מדווח `ready:false` נכון, אבל `cargo test -- --ignored` נכשל ב־`numpy_not_available` (וזה נכון — הוא כבר לא מעמיד פנים שעבר).
- `cmake` לא מותקן ⇒ `sidecars/libkeyfinder_cli/build.sh` נכתב אך **לא הורץ בהצלחה כאן**. יש עכשיו מתכון בנייה; ההוכחה שהוא מתקמפל חסרה.
- `tauri build` לא הורץ (דורש תלויות מערכת של webkit2gtk). `frontendDist` ו־`resources` תוקנו ומאומתים סטטית, אך האריזה עצמה לא נבדקה מקצה לקצה.
