export class PlatformAdapter {
  constructor(name, config, page) {
    this.name = name;
    this.config = config;
    this.page = page;
  }

  assertInspectable() {
    const status = this.config.sites[this.name]?.implementationStatus;
    if (!['discovery_complete', 'ready'].includes(status)) {
      throw new Error(
        `${this.name.toUpperCase()} adapter is not bound to the signed-in UI yet. ` +
        'Provide the unalign SOP and a signed-in discovery session before changing implementationStatus to ready.'
      );
    }
    if (!this.page) throw new Error(`${this.name.toUpperCase()} adapter requires a Playwright page.`);
  }

  assertReady() {
    this.assertInspectable();
    if (this.config.sites[this.name]?.implementationStatus !== 'ready') {
      throw new Error(
        `${this.name.toUpperCase()} selectors were discovered, but the final submit step has not passed a controlled live test. ` +
        'Keep implementationStatus as discovery_complete until that test is completed.'
      );
    }
  }

  async inspect() {
    this.assertInspectable();
    throw new Error(`${this.name} inspect() is not implemented.`);
  }

  async unalign() {
    this.assertReady();
    throw new Error(`${this.name} unalign() is not implemented.`);
  }
}
