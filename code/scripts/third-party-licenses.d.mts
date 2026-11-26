export function generateThirdPartyLicenses(options?: { code?: string; candidate?: string }): {
  files: Map<string, string | Uint8Array>
  figLocations: Set<string>
}

export function checkFigModules(
  code: string, locations: ReadonlySet<string>, moduleIds: readonly string[], imports?: readonly string[]
): void

export function assertLicensePayload(app: string): Promise<void>

export function stageApplicationPayload(
  build: string, app: string, manifest: { name: string; productName: string; version: string }
): Promise<void>
