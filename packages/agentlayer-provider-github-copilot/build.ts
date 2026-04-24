import { buildPackageFromManifest } from '../../scripts/build/package-build.ts'

await buildPackageFromManifest(import.meta.dir)
