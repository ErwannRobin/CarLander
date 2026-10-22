# Contributing

Thanks for your interest in ROADSTER FLIGHT.

## Setup

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

## Before opening a pull request

```bash
make check   # same as: npm run typecheck && npm test && npm run build
```

CI runs the same checks. Level changes should keep `tests/levels/*` passing: those tests
check that each level can be completed and that the reference pilot still lands.

## Guidelines

- Keep changes small and focused. One topic per pull request.
- Follow the existing code style and the module layout in [ARCHITECTURE.md](ARCHITECTURE.md).
- Everything is procedural: please do not add external art or audio assets unless you own them
  or they have a license compatible with MIT, and say where they come from in the pull request.
- Contributions are licensed under the [MIT License](LICENSE).
