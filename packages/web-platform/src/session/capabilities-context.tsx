import { createContext, useContext, type ReactNode } from 'react';

/** Deployment features the shell may offer, from `GET /api/v1/me`. Display hints, never permission. */
export interface Capabilities {
  readonly sites: boolean;
  /** The remote MCP endpoint, or null when only stdio through nixctl is available. */
  readonly mcpUrl: string | null;
  /** Listed as a deployment operator: may read instance-wide data such as backup status. */
  readonly operator: boolean;
  /** May decide first publishes of sites. */
  readonly siteApprover: boolean;
  /** Holds the tenant administrator role (from `isTenantAdministrator`, not `features`). */
  readonly tenantAdministrator: boolean;
}

/** Everything off until Core has answered: an entry that may not exist is not drawn first. */
export const NO_CAPABILITIES: Capabilities = {
  sites: false,
  mcpUrl: null,
  operator: false,
  siteApprover: false,
  tenantAdministrator: false,
};

const CapabilitiesContext = createContext<Capabilities>(NO_CAPABILITIES);

export function CapabilitiesProvider({
  value,
  children,
}: {
  readonly value: Capabilities | null | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <CapabilitiesContext.Provider value={value ?? NO_CAPABILITIES}>
      {children}
    </CapabilitiesContext.Provider>
  );
}

export function useCapabilities(): Capabilities {
  return useContext(CapabilitiesContext);
}
