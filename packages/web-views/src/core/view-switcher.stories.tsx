import { Button } from '@nix/ui';
import { MessageSquare } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { View } from '@nix/web-collections/core/container-model';
import { ViewSwitcher } from './view-switcher';

export default { title: 'Nix/Views/View switcher' };

const list: View = {
  id: 'list',
  kind: 'list',
  name: 'List',
  columns: [],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  filters: [],
};
const calendar: View = { ...list, id: 'calendar', name: 'Calendar', kind: 'calendar' };

function ItemViews(): ReactNode {
  const [active, select] = useState('list');
  const [showCalendar, setShowCalendar] = useState(true);
  return (
    <ViewSwitcher
      views={showCalendar ? [list, calendar] : [list]}
      unrenderable={[]}
      activeViewId={active}
      defaultViewId="list"
      documentLabel="Document"
      context={{ id: 'comments', label: 'Comments', icon: MessageSquare }}
      onSelect={select}
      addView={<Button variant="secondary">Add view</Button>}
      viewActions={(id) =>
        id === calendar.id
          ? [
              {
                label: 'Hide from tabs',
                onSelect: () => {
                  setShowCalendar(false);
                },
              },
            ]
          : showCalendar
            ? []
            : [
                {
                  label: 'Show Calendar',
                  onSelect: () => {
                    setShowCalendar(true);
                  },
                },
              ]
      }
    />
  );
}

export const ManageViews = { render: (): ReactNode => <ItemViews /> };
