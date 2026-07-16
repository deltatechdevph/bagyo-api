import { describe, expect, it } from 'vitest';
import { BulletinParseError, parseBulletinHtml } from './html.js';

function page(body: string): string {
  return `<html><body><div class="container">${body}</div></body></html>`;
}

const PANE = `
<div class="article-header">Tropical Cyclone Bulletin #7</div>
<div class="article-content">
  <ul class="nav nav-tabs">
    <li><a href="#tcwb-1" data-header="Tropical Cyclone Bulletin #7" class="swb">Typhoon "Paolo"</a></li>
  </ul>
  <div role="tabpanel" class="tab-pane active" id="tcwb-1">
    <div class="row"><div class="col-md-6 text-center"><h3>Typhoon "Paolo"</h3></div></div>
    <div class="row"><div class="col-md-6 text-center">
      <h5>Issued at 5:00 am, 03 October 2026</h5>
      <h5>(Valid for broadcast until the next advisory to be issued at 11:00 AM today)</h5>
    </div></div>
    <div class="row"><div class="col-md-6">
      <h5>PAOLO INTENSIFIES OVER THE PHILIPPINE SEA.</h5>
    </div></div>
    <div class="row"><div class="col-md-6">
      <div class="panel"><div class="panel-heading">Location of Eye/center</div>
        <div class="panel-body"><p>The center of the eye of Typhoon PAOLO was estimated based on all available data at 230 km East of Casiguran, Aurora (16.2 °N, 124.3 °E)</p></div></div>
      <div class="panel"><div class="panel-heading">Movement</div>
        <div class="panel-body"><p>Moving West northwestward at 15 km/h</p></div></div>
      <div class="panel"><div class="panel-heading">Strength</div>
        <div class="panel-body"><p>Maximum sustained winds of 130 km/h near the center and gustiness of up to 160 km/h</p></div></div>
    </div></div>
    <div class="row"><div class="col-md-12">
      <div class="panel"><div class="panel-heading">Wind Signal</div>
        <table class="table text-center table-header">
          <thead><tr><th colspan="2" class="signalno2">Tropical Cyclone Wind Signal no. <img src="https://x/tcws2.png"></th></tr></thead>
          <tbody>
            <tr><td><strong>Affected Areas</strong></td>
              <td><ul>
                <li><strong>Luzon</strong>
                  <ul><li>The eastern portion of Aurora (Casiguran, Dilasag, Dinalungan)</li></ul>
                </li>
              </ul></td></tr>
          </tbody>
          <thead><tr><th colspan="2" class="signalno1">Tropical Cyclone Wind Signal no. <img src="https://x/tcws1.png"></th></tr></thead>
          <tbody>
            <tr><td><strong>Affected Areas</strong></td>
              <td><ul>
                <li><strong>Luzon</strong>
                  <ul><li>The rest of Aurora, Quirino, and Nueva Vizcaya</li></ul>
                </li>
                <li><strong>Visayas</strong>
                  <ul><li>Northern Samar</li></ul>
                </li>
              </ul></td></tr>
          </tbody>
        </table>
      </div>
    </div></div>
  </div>
</div>`;

describe('parseBulletinHtml — synthetic markup', () => {
  it('parses a full bulletin pane', () => {
    const { bulletins, issues } = parseBulletinHtml(page(PANE));
    expect(issues).toEqual([]);
    expect(bulletins).toHaveLength(1);
    const b = bulletins[0]!;
    expect(b).toMatchObject({
      bulletinNumber: 7,
      pagasaName: 'PAOLO',
      category: 'TY',
      issuedAt: '2026-10-03T05:00:00+08:00',
      nextBulletinAt: '2026-10-03T11:00:00+08:00',
      headline: 'PAOLO INTENSIFIES OVER THE PHILIPPINE SEA.',
      maxWindsKph: 130,
      gustinessKph: 160,
      pressureHpa: null,
      movementDirection: 'West northwestward',
      movementSpeedKph: 15,
    });
    expect(b.center).toMatchObject({ lat: 16.2, lng: 124.3 });
    expect(b.signals.map((s) => s.signalLevel)).toEqual([2, 1]);
    const s1 = b.signals[1]!;
    expect(s1.areas.find((a) => a.locationName === 'Northern Samar')).toMatchObject({
      islandGroup: 'visayas',
      locationType: 'PROVINCE',
    });
    expect(s1.areas.find((a) => a.locationName === 'Aurora')).toMatchObject({
      partialDescriptor: 'rest',
    });
  });

  it('returns empty for the no-active state', () => {
    const r = parseBulletinHtml(
      page(
        '<div class="article-content"><h3>No Active Tropical Cyclone within the Philippine Area of Responsibility</h3></div>',
      ),
    );
    expect(r.bulletins).toEqual([]);
  });

  it('throws on pages with neither bulletins nor the no-active notice', () => {
    expect(() => parseBulletinHtml(page('<p>maintenance</p>'))).toThrow(BulletinParseError);
  });

  it('throws when a pane is missing its issuance time', () => {
    const broken = PANE.replace(/Issued at 5:00 am, 03 October 2026/, 'Issued at soon');
    expect(() => parseBulletinHtml(page(broken))).toThrow(BulletinParseError);
  });

  it('throws when the designation line is unparseable', () => {
    const broken = PANE.replace(/<h3>Typhoon "Paolo"<\/h3>/, '<h3>???</h3>');
    expect(() => parseBulletinHtml(page(broken))).toThrow(BulletinParseError);
  });

  it('throws when the bulletin number is missing', () => {
    const broken = PANE.replaceAll('Tropical Cyclone Bulletin #7', 'Bulletin');
    expect(() => parseBulletinHtml(page(broken))).toThrow(BulletinParseError);
  });
});
