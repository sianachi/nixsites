import { Button, Icon, Text } from '@nix/ui';
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  IndentDecrease,
  IndentIncrease,
  Pencil,
  Plus,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { titleOf, type OutlineRow } from './outline-model';

interface OutlineToolbarProps {
  readonly row: OutlineRow | null;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onAdd: () => void;
  readonly onRename: () => void;
  readonly onIndent: () => void;
  readonly onOutdent: () => void;
  readonly onUp: () => void;
  readonly onDown: () => void;
}

// On a phone the main ways to act carry a short word beside the glyph.
const labelled =
  'shrink-0 any-pointer-coarse:w-auto any-pointer-coarse:gap-1 any-pointer-coarse:px-3';

/**
 * The structural edits as one row of icon buttons, acting on the row last focused - a phone has no
 * Tab key. Each is named for the row it acts on, so no caption has to say which row that is.
 */
export function OutlineToolbar(props: OutlineToolbarProps): ReactNode {
  const { row, busy, onOpen, onAdd, onRename, onIndent, onOutdent, onUp, onDown } = props;
  const name = row === null ? '' : ` "${titleOf(row.item)}"`;
  const disabled = row === null || busy;
  return (
    <div
      role="group"
      aria-label="Outline actions"
      aria-busy={busy}
      className="flex flex-wrap items-center gap-1"
    >
      <Button variant="icon" aria-label="Add item" onClick={onAdd} disabled={busy}>
        <Icon icon={Plus} size="sm" />
      </Button>
      <Button variant="icon" aria-label={`Rename${name}`} onClick={onRename} disabled={disabled}>
        <Icon icon={Pencil} size="sm" />
      </Button>
      <Button variant="icon" aria-label="Open" onClick={onOpen} disabled={row === null}>
        <Icon icon={ExternalLink} size="sm" />
      </Button>
      <Button
        variant="icon"
        className={labelled}
        aria-label={`Indent${name}`}
        onClick={onIndent}
        disabled={disabled}
      >
        <Icon icon={IndentIncrease} size="sm" />
        <Text
          as="span"
          variant="caption"
          aria-hidden="true"
          className="hidden whitespace-nowrap any-pointer-coarse:inline"
        >
          Indent
        </Text>
      </Button>
      <Button
        variant="icon"
        className={labelled}
        aria-label={`Outdent${name}`}
        onClick={onOutdent}
        disabled={disabled}
      >
        <Icon icon={IndentDecrease} size="sm" />
        <Text
          as="span"
          variant="caption"
          aria-hidden="true"
          className="hidden whitespace-nowrap any-pointer-coarse:inline"
        >
          Outdent
        </Text>
      </Button>
      <Button
        variant="icon"
        className={labelled}
        aria-label={`Move${name} up`}
        onClick={onUp}
        disabled={disabled}
      >
        <Icon icon={ArrowUp} size="sm" />
        <Text
          as="span"
          variant="caption"
          aria-hidden="true"
          className="hidden whitespace-nowrap any-pointer-coarse:inline"
        >
          Up
        </Text>
      </Button>
      <Button
        variant="icon"
        className={labelled}
        aria-label={`Move${name} down`}
        onClick={onDown}
        disabled={disabled}
      >
        <Icon icon={ArrowDown} size="sm" />
        <Text
          as="span"
          variant="caption"
          aria-hidden="true"
          className="hidden whitespace-nowrap any-pointer-coarse:inline"
        >
          Down
        </Text>
      </Button>
    </div>
  );
}
