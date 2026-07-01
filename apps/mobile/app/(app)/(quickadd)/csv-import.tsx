import CsvImport from '../../../src/components/CsvImport';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddCsvImportScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Import CSV">
      {onSaved => <CsvImport onImported={onSaved} />}
    </QuickAddScreenShell>
  );
}
