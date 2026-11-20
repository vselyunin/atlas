import * as Menu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';

export const DropdownMenu = Menu.Root;
export const DropdownTrigger = Menu.Trigger;
export const DropdownRadioGroup = Menu.RadioGroup;

export function DropdownContent({ className = '', ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        align="start"
        sideOffset={10}
        collisionPadding={12}
        className={`dropdown-content ${className}`}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownItem(props: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className="dropdown-item" {...props} />;
}

export function DropdownRadioItem(props: ComponentProps<typeof Menu.RadioItem>) {
  return <Menu.RadioItem className="dropdown-item" {...props} />;
}

export function DropdownSeparator() {
  return <Menu.Separator className="dropdown-separator" />;
}
