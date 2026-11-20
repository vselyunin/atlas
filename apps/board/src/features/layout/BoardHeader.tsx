import { useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Layers3, Plus } from 'lucide-react';
import type { Project, Version } from '@atlas/contracts';
import {
  DropdownMenu,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownSeparator,
} from '../../components/ui/dropdown-menu';
import { useTheme } from '../../lib/useTheme';

type BoardHeaderProps = {
  projects: Project[];
  projectId: string;
  versions: Version[];
  versionId: string;
  ready: boolean;
  taskCreationDisabled: boolean;
  workerStatus: string;
  onSelectProject: (id: string) => void;
  onSelectVersion: (id: string) => void;
  onCreateProject: () => void;
  onCreateVersion: () => void;
  onCreateTask: () => void;
};

function ResourceMenu({
  label,
  items,
  value,
  disabled = false,
  onSelect,
  onCreate,
}: {
  label: 'Project' | 'Version';
  items: { id: string; name: string }[];
  value: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  // Open the dialog only once the menu has restored focus to its trigger.
  const pendingCreation = useRef(false);
  const current = items.find((item) => item.id === value)?.name ?? `Select ${label.toLowerCase()}`;
  return (
    <DropdownMenu>
      <DropdownTrigger
        className="resource-trigger"
        aria-label={label}
        disabled={disabled}
        title={current}
      >
        <span>{current}</span>
        <ChevronDown size={14} />
      </DropdownTrigger>
      <DropdownContent
        onCloseAutoFocus={() => {
          if (pendingCreation.current) {
            pendingCreation.current = false;
            // The menu finishes focus restoration before the dialog mounts.
            requestAnimationFrame(onCreate);
          }
        }}
      >
        <DropdownItem
          onSelect={() => {
            pendingCreation.current = true;
          }}
        >
          <Plus size={14} />
          Create {label.toLowerCase()}
        </DropdownItem>
        {items.length > 0 && (
          <>
            <DropdownSeparator />
            <DropdownRadioGroup value={value} onValueChange={onSelect}>
              {items.map((item) => (
                <DropdownRadioItem key={item.id} value={item.id}>
                  {item.name}
                </DropdownRadioItem>
              ))}
            </DropdownRadioGroup>
          </>
        )}
      </DropdownContent>
    </DropdownMenu>
  );
}

export function BoardHeader(props: BoardHeaderProps) {
  const { preference, setPreference } = useTheme();
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="Atlas home">
        <span className="brand-mark">
          <Layers3 size={22} />
        </span>
        atlas
      </a>
      <nav className="project-controls" aria-label="Workspace">
        <ResourceMenu
          label="Project"
          items={props.projects}
          value={props.projectId}
          onSelect={props.onSelectProject}
          onCreate={props.onCreateProject}
        />
        <span className="selector-divider" aria-hidden="true">
          /
        </span>
        <ResourceMenu
          label="Version"
          items={props.versions}
          value={props.versionId}
          disabled={!props.ready}
          onSelect={props.onSelectVersion}
          onCreate={props.onCreateVersion}
        />
      </nav>
      <div className="header-right">
        <span className="worker-status">{props.workerStatus}</span>
        <button
          className="button primary"
          disabled={props.taskCreationDisabled}
          onClick={props.onCreateTask}
        >
          <Plus size={16} />
          New task
        </button>
        <Popover.Root>
          <Popover.Trigger className="user-avatar" aria-label="User settings">
            V
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="dropdown-content user-menu"
              align="end"
              sideOffset={10}
              collisionPadding={12}
              aria-label="User settings"
            >
              <div className="user-identity">
                <strong>Vladi</strong>
                <span>Personal workspace</span>
              </div>
              <div className="dropdown-separator" />
              <div className="appearance-row">
                <label htmlFor="appearance">Appearance</label>
                <div className="appearance-select">
                  <select
                    id="appearance"
                    value={preference}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === 'system' || value === 'light' || value === 'dark')
                        setPreference(value);
                    }}
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                  <ChevronDown size={14} aria-hidden="true" />
                </div>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </header>
  );
}
