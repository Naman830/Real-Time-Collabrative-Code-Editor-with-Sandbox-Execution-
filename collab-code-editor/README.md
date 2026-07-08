This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

### Sandbox execution (Piston) setup

Code execution runs through a self-hosted [Piston](https://github.com/engineer-man/piston) instance via `exec-server`. Bring it up with:

```bash
docker compose up -d
```

This starts the `piston` container and a one-shot `piston-init` service (`scripts/install-piston-runtimes.js`) that automatically installs every language package the editor's language switcher needs (see `LANGUAGE_MAP` in `app/api/execute/route.ts`) and verifies each one comes up as a runnable runtime before exiting. On a fresh volume this can take several minutes (Java and C++/gcc are the slowest). Installed packages persist in the `piston_data` volume, so this is a fast no-op on every subsequent `docker compose up`.

If `docker logs piston_init` doesn't end with `all N runtimes verified available. done.`, code execution will silently return empty output instead of real stdout/stderr — check that log before assuming the editor itself is broken.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
