import React from 'react';
import { FormFieldId } from '../../constants/formFields';
import { useHiddenFields } from '../../hooks/useHiddenFields';

interface Props {
  fieldId: FormFieldId;
  children: React.ReactNode;
}

/**
 * Renders children only when the given field has NOT been hidden by an admin.
 * Hidden fields return null — they are completely absent from the DOM, not
 * merely collapsed, so they remain invisible even if the user has expanded
 * the "Show advanced fields" section.
 *
 * Usage:
 *   <HidableField fieldId="jobs.customer_name">
 *     <View style={s.fieldWrap}>…</View>
 *   </HidableField>
 */
export function HidableField({ fieldId, children }: Props) {
  const { isHidden } = useHiddenFields();
  if (isHidden(fieldId)) return null;
  return <>{children}</>;
}
