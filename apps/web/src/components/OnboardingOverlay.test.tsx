// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { finalCtaFor } from "./OnboardingOverlay.tsx";

/**
 * ONB-01 — the final step's smart-routing gates (native OnboardingViews:
 * "Land the user in the one place that fixes what's still missing"). The
 * models gate is native's pi-models setup row: a CONNECTED provider whose
 * catalog is empty/failed is NOT ready to code — route to Models, never
 * "Start Coding".
 */
describe("finalCtaFor (ONB-01 readiness gates)", () => {
  const ready = {
    piMissing: false,
    providerMissing: false,
    modelsMissing: false,
    projectMissing: false,
  };

  it("routes to Doctor first when pi/node are broken", () => {
    expect(finalCtaFor({ ...ready, piMissing: true, providerMissing: true }).view).toBe("doctor");
  });

  it("routes to Providers when no provider is connected", () => {
    expect(finalCtaFor({ ...ready, providerMissing: true }).view).toBe("providers");
  });

  it("routes to Providers when the provider is connected but NO usable models load", () => {
    const cta = finalCtaFor({ ...ready, modelsMissing: true });
    expect(cta.view).toBe("providers");
    expect(cta.label).toBe("Load AI Models");
  });

  it("routes to Projects when only the projects folder is missing", () => {
    expect(finalCtaFor({ ...ready, projectMissing: true }).view).toBe("projects");
  });

  it("fully green goes straight to coding", () => {
    const cta = finalCtaFor(ready);
    expect(cta.view).toBe("chat");
    expect(cta.label).toBe("Start Coding");
  });
});
