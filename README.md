# Fichad2

Multi-company time tracking SaaS for web/PWA access.

## Environment separation

The app loads Firebase web config from Vite environment variables in `src/firebase.js`.

Local emulator QA:

```powershell
Copy-Item .env.local.example .env.local
npm run dev
```

For LAN/mobile emulator QA, set:

```text
VITE_USE_FIREBASE_EMULATORS=true
VITE_FIREBASE_EMULATOR_HOST=192.168.x.x
```

Production pilot:

```powershell
Copy-Item .env.production.example .env.production
npm run build
```

Production must use:

```text
VITE_USE_FIREBASE_EMULATORS=false
VITE_ENABLE_COMPANY_SIGNUP=false
```

To verify the production build is not using emulators, inspect the built app environment before deploy and confirm:

- `VITE_USE_FIREBASE_EMULATORS=false`
- `VITE_FIREBASE_EMULATOR_HOST` is empty or unused
- the deployed Firebase project ID matches the real production project

## Private one-company pilot

1. Create or select the production Firebase project.
2. Enable Email/Password Auth.
3. Add the private URL to Firebase Auth authorized domains.
4. Fill `.env.production` with the Firebase web app config.
5. Keep `VITE_ENABLE_COMPANY_SIGNUP=false`.
6. Run `npm run build`.
7. Deploy Firestore rules only after `npm run test:rules` passes.
8. Deploy Hosting only after explicit approval.

## Create first real company and admin

Use the controlled onboarding script with a production service account kept outside the repo:

```powershell
npm run onboard:client -- "C:\ruta\serviceAccount.json" --company-name "Empresa Demo SL" --admin-email "admin@empresademo.com" --cif "B12345678" --address "Calle Mayor 1" --responsable "Nombre Apellido"
```

Options:

- `--company-id`: fixed company ID.
- `--admin-password`: initial admin password.

If `--admin-password` is omitted, the script generates a temporary password and prints it once. It also prints email verification and password reset links.

## Worker invitation flow

1. Admin logs in after email verification.
2. Admin creates worker invitations from the admin panel.
3. Worker registers with the invited email.
4. Worker verifies email.
5. Worker can clock entrada/salida.
6. Admin verifies logs and exports from the dashboard.

## Self-service company signup

The login screen can show `Soy empresa nueva: crear alta inicial` only when:

```text
VITE_ENABLE_COMPANY_SIGNUP=true
```

Keep it `false` for the private production pilot.

## Firebase deploy commands

Rules only:

```powershell
firebase deploy --only firestore:rules
```

Hosting only:

```powershell
firebase deploy --only hosting
```

Do not deploy production until the target Firebase project, environment file, build, rules tests, and manual pilot checklist are approved.
