import { Button } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';

import { PhoneNavbar } from './phone/phone-navbar';
import { PhoneTopRow } from './phone/phone-top-row';

export default {
  title: 'Nix/Shell/Phone workspace controls',
  parameters: { layout: 'fullscreen' },
};

const homePath = '/w/story-workspace';
const noop = (): void => undefined;

function Example(): ReactNode {
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const homeCurrent = useLocation().search === '';
  const [navigationHidden, setNavigationHidden] = useState(false);
  return (
    <>
      <PhoneTopRow
        homePath={homePath}
        homeCurrent={homeCurrent}
        onHome={noop}
        navigationHidden={navigationHidden}
        onToggleNavigation={() => {
          setNavigationHidden((hidden) => !hidden);
        }}
        sidebarToggleRef={sidebarToggleRef}
        sidebarVisible={false}
        onToggleSidebar={noop}
        hasItem={!homeCurrent}
        profile={<Button variant="ghost">Account</Button>}
      />
      <PhoneNavbar
        hidden={navigationHidden}
        explorerOpen={false}
        onCloseExplorer={noop}
        menu={<Button variant="ghost">Menu</Button>}
        creating={false}
        tabCount={1}
        onSearch={noop}
        onCreate={noop}
        onTabs={noop}
      />
    </>
  );
}

export const FromNote = {
  render: (): ReactNode => (
    <MemoryRouter initialEntries={[`${homePath}?item=note`]}>
      <Example />
    </MemoryRouter>
  ),
};

export const OnHomebase = {
  render: (): ReactNode => (
    <MemoryRouter initialEntries={[homePath]}>
      <Example />
    </MemoryRouter>
  ),
};
