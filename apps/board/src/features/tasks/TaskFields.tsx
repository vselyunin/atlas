import { Select } from '../../components/ui/select';
import type { TaskCreate, Worker, Version } from '@atlas/contracts';
import { PrioritySchema, TaskTypeSchema } from '@atlas/contracts';

export const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export function TaskFields({
  value,
  onChange,
  workers,
  locked = false,
  descriptionLocked = false,
  versions,
  versionId,
  onVersionChange,
}: {
  value: TaskCreate;
  onChange: (value: TaskCreate) => void;
  workers: Worker[];
  locked?: boolean;
  descriptionLocked?: boolean;
  versions?: Version[];
  versionId?: string;
  onVersionChange?: (id: string) => void;
}) {
  return (
    <div className="form-fields">
      <label>
        Title
        <input
          aria-label="Title"
          required
          maxLength={200}
          value={value.title}
          disabled={locked}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          placeholder="What needs to be done?"
        />
      </label>
      <label>
        Description
        <textarea
          aria-label="Description"
          maxLength={100000}
          rows={5}
          value={value.description}
          disabled={descriptionLocked}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          placeholder="Add context, requirements, or a definition of done…"
        />
      </label>
      <div className="form-row">
        <label>
          Type
          <Select
            aria-label="Type"
            disabled={locked}
            value={value.type}
            onChange={(e) => onChange({ ...value, type: TaskTypeSchema.parse(e.target.value) })}
          >
            {TaskTypeSchema.options.map((type) => (
              <option key={type} value={type}>
                {label(type)}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Priority
          <Select
            aria-label="Priority"
            disabled={locked}
            value={value.priority}
            onChange={(e) => onChange({ ...value, priority: PrioritySchema.parse(e.target.value) })}
          >
            {PrioritySchema.options.map((priority) => (
              <option key={priority} value={priority}>
                {label(priority)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <label>
        Responsible worker
        <Select
          aria-label="Responsible worker"
          value={value.assigneeId ?? ''}
          disabled={locked}
          onChange={(e) => onChange({ ...value, assigneeId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          <optgroup label="Humans">
            {workers
              .filter((worker) => worker.kind === 'human')
              .map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                </option>
              ))}
          </optgroup>
          <optgroup label="Atlas workers">
            {workers
              .filter((worker) => worker.kind === 'atlas')
              .map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                  {worker.availability === 'offline' ? ' · offline' : ''}
                </option>
              ))}
          </optgroup>
        </Select>
      </label>
      {versions && onVersionChange && (
        <label>
          Version
          <Select
            aria-label="Version"
            value={versionId}
            disabled={locked}
            onChange={(e) => onVersionChange(e.target.value)}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.name}
              </option>
            ))}
          </Select>
        </label>
      )}
    </div>
  );
}
