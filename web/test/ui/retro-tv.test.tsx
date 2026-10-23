// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { Companion } from '../../src/core/lab/companion';
import { LabBus } from '../../src/core/lab/events';
import { CommandRegistry } from '../../src/core/lab/registry';
import { RetroTv } from '../../src/ui/lab/RetroTv';
import { mount, unmountAll, wait } from './dom';

afterEach(unmountAll);

describe('RetroTv', () => {
  it('the dial label shows after a turn, then goes away by itself', async () => {
    const companion = new Companion(new LabBus(), { lang: 'en', reducedMotion: () => true, watch: 'DEVICE', profile: 'hwdog' });
    companion.setPower(true);
    await wait(3000);
    const root = mount(<RetroTv companion={companion} registry={new CommandRegistry()} reducedMotion />);
    await wait(50);
    companion.turnDial(1);
    await wait(100);
    expect(root.querySelector('.tv-osd')?.textContent).toBeTruthy();
    await wait(2000);
    expect(root.querySelector('.tv-osd')).toBeNull();
    companion.dispose();
  }, 10_000);
});
