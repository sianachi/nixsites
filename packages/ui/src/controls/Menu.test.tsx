import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { Menu, type MenuEntry } from './Menu';

/** The trigger every test shares: a plain button with the render prop spread onto it. */
function trigger(name = 'Actions') {
  return (props: Parameters<Parameters<typeof Menu>[0]['children']>[0]) => (
    <button {...props}>{name}</button>
  );
}

const ACTION_ITEMS: MenuEntry[] = [
  { kind: 'action', label: 'New workspace', onSelect: vi.fn() },
  { kind: 'action', label: 'Settings', icon: Settings, onSelect: vi.fn() },
  { kind: 'separator' },
  { kind: 'action', label: 'Delete workspace', destructive: true, onSelect: vi.fn() },
];

describe('Menu', () => {
  it('places ordinary panels outside their containing pane', async () => {
    const user = userEvent.setup();
    const view = render(
      <div>
        <Menu label="Actions" items={ACTION_ITEMS} children={trigger()} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu').parentElement).toBe(document.body);
    expect(view.container).not.toContainElement(screen.getByRole('menu'));
  });

  it('keeps a menu opened in a native dialog inside that dialog', async () => {
    const user = userEvent.setup();
    render(
      <dialog open aria-label="Item settings">
        <Menu label="Actions" items={ACTION_ITEMS} children={trigger()} />
      </dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu').parentElement).toBe(
      screen.getByRole('dialog', { name: 'Item settings' }),
    );
  });

  it('dismisses on a touch outside without waiting for a compatibility mouse event', async () => {
    render(<Menu label="Actions" items={ACTION_ITEMS} children={trigger()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps focus on a control opened by a menu action', async () => {
    render(
      <>
        <Menu
          label="Actions"
          items={[
            {
              label: 'Rename',
              onSelect: () => {
                screen.getByRole('textbox', { name: 'Title editor' }).focus();
              },
            },
          ]}
          children={trigger()}
        />
        <input aria-label="Title editor" />
      </>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByRole('textbox', { name: 'Title editor' })).toHaveFocus();
  });

  it('keeps the native clipboard menu on editable controls inside a content panel', async () => {
    render(
      <Menu
        label="Tools"
        items={[
          {
            kind: 'content',
            content: <input aria-label="Title" />,
          },
        ]}
        children={trigger()}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Actions' }));
    expect(fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Title' }))).toBe(true);
  });

  it('focuses an unavailable menu so Escape can still dismiss it', async () => {
    render(
      <Menu
        label="Unavailable tools"
        items={[
          {
            label: 'Save',
            disabled: true,
            onSelect: vi.fn(),
          },
        ]}
        children={trigger()}
      />,
    );
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Actions' });
    await user.click(button);
    expect(screen.getByRole('menu', { name: 'Unavailable tools' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('continues from the trigger when tabbing out of a portaled action menu', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Menu label="Actions" items={ACTION_ITEMS} children={trigger()} />
        <button>Next control</button>
      </>,
    );
    const button = screen.getByRole('button', { name: 'Actions' });
    await user.click(button);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(button);
    await user.tab({ shift: true });
    expect(button).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('starts closed, with a trigger that names the menu it opens', () => {
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);

    const button = screen.getByRole('button', { name: 'Actions' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on click, as a menu with the name it was given', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);

    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menu', { name: 'Workspace actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('renders a separator between the runs it was given, and nothing either side of it', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('marks a destructive item without reaching for a colour the token sheet does not have', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveClass('font-semibold');
  });

  it('selecting an item closes the menu, runs its handler once, and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const items: MenuEntry[] = [{ kind: 'action', label: 'New workspace', onSelect }];
    render(<Menu label="Workspace actions" items={items} children={trigger()} />);
    const button = screen.getByRole('button', { name: 'Actions' });

    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'New workspace' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it.each([
    ['ArrowDown', 'first', 'New workspace'],
    ['ArrowUp', 'last', 'Delete workspace'],
  ])('%s on the trigger opens the menu onto its %s item', async (key, _end, name) => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);

    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard(`{${key}}`);

    expect(screen.getByRole('menuitem', { name })).toHaveFocus();
  });

  it('ArrowDown and ArrowUp move focus between items and wrap at the ends', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'New workspace' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();
  });

  it('Home and End jump to the first and last item', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'New workspace' })).toHaveFocus();
  });

  it('a disabled item is skipped by arrow-key navigation', async () => {
    const user = userEvent.setup();
    const items: MenuEntry[] = [
      { kind: 'action', label: 'New workspace', onSelect: vi.fn() },
      { kind: 'action', label: 'Settings', disabled: true, onSelect: vi.fn() },
      { kind: 'action', label: 'Archive', onSelect: vi.fn() },
    ];
    render(<Menu label="Workspace actions" items={items} children={trigger()} />);
    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeDisabled();
  });

  it('Escape closes the menu and hands focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    const button = screen.getByRole('button', { name: 'Actions' });
    button.focus();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('a click outside the trigger and the panel closes the menu without acting on anything', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const items: MenuEntry[] = [{ kind: 'action', label: 'New workspace', onSelect }];
    render(
      <div>
        <Menu label="Workspace actions" items={items} children={trigger()} />
        <p>Outside</p>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByText('Outside'));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders a link item as a real link, through the caller-supplied router link', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const items: MenuEntry[] = [
      { kind: 'link', label: 'Settings', href: '/w/1/settings', onSelect },
    ];
    render(
      <Menu
        label="Account"
        items={items}
        children={trigger()}
        renderLink={({ href, children, ...rest }) => (
          <a data-router-to={href} href={href} {...rest}>
            {children}
          </a>
        )}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const link = screen.getByRole('menuitem', { name: 'Settings' });

    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('data-router-to', '/w/1/settings');

    await user.click(link);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('items are 44px tall under a coarse pointer, the same step Button.tsx reaches for a touch target', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveClass(
      'any-pointer-coarse:min-h-(--control-lg)',
    );
  });

  it('renders a `content` entry as given, outside the roving item order', async () => {
    const user = userEvent.setup();
    const items: MenuEntry[] = [
      { kind: 'content', content: <p>Signed in as Ada</p> },
      { kind: 'action', label: 'Sign out', onSelect: vi.fn() },
    ];
    render(<Menu label="Account" items={items} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByText('Signed in as Ada')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
  });

  it('a `content` render function can close the menu, for its own plain links', async () => {
    const user = userEvent.setup();
    const items: MenuEntry[] = [
      {
        kind: 'content',
        content: ({ close }) => (
          <a href="/elsewhere" onClick={close}>
            Elsewhere
          </a>
        ),
      },
    ];
    render(<Menu label="Account" items={items} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    await user.click(screen.getByRole('link', { name: 'Elsewhere' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape closes the menu even from a `content` entry, which has no menuitem of its own', async () => {
    const user = userEvent.setup();
    const items: MenuEntry[] = [{ kind: 'content', content: <input aria-label="Search" /> }];
    render(<Menu label="Account" items={items} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('textbox', { name: 'Search' }));

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('focuses and tabs through ordinary content controls before dismissing on exit', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Menu
          label="Workspaces"
          items={[
            {
              kind: 'content',
              content: (
                <>
                  <a href="/first">First workspace</a>
                  <a href="/second">Second workspace</a>
                </>
              ),
            },
          ]}
          children={trigger()}
        />
        <button>Next control</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    expect(screen.getByRole('link', { name: 'First workspace' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Second workspace' })).toHaveFocus();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens content onto its last control with ArrowUp and dismisses when tabbing back to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <Menu
        label="Workspaces"
        items={[
          {
            kind: 'content',
            content: (
              <>
                <a href="/first">First workspace</a>
                <a href="/second">Second workspace</a>
              </>
            ),
          },
        ]}
        children={trigger()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Actions' });
    button.focus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('link', { name: 'Second workspace' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('link', { name: 'First workspace' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(button).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps settings controls reachable from commands in a mixed panel', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Menu
          label="Account"
          items={[
            { kind: 'content', content: <input aria-label="Appearance" /> },
            { kind: 'action', label: 'Settings', onSelect: vi.fn() },
          ]}
          children={trigger()}
        />
        <button>Next control</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('textbox', { name: 'Appearance' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('becomes a full-width bottom sheet below the sm breakpoint', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menu')).toHaveClass('max-sm:rounded-b-none');
  });

  it('exposes checkable items with their state, and toggles through the keyboard', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const items: MenuEntry[] = [
      { label: 'Auto-apply', role: 'menuitemcheckbox', checked: true, onSelect },
      { label: 'Read only', role: 'menuitemradio', checked: false, onSelect: vi.fn() },
      { label: 'Plain', onSelect: vi.fn() },
    ];
    render(<Menu label="Options" items={items} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menuitemcheckbox', { name: 'Auto-apply' })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: 'Read only' })).not.toBeChecked();
    expect(screen.getByRole('menuitem', { name: 'Plain' })).not.toHaveAttribute('aria-checked');

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
