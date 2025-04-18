/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { useContext, useEffect, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import * as yup from 'yup'
import { isFormValid, validatePubkey } from '@utils/formValidation'
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes'
import { NewProposalContext } from '../../../../new'
import useGovernanceAssets from '@hooks/useGovernanceAssets'
import { Governance } from '@solana/spl-governance'
import { ProgramAccount } from '@solana/spl-governance'
import { serializeInstructionToBase64 } from '@solana/spl-governance'
import { AccountType, AssetAccount } from '@utils/uiTypes/assets'
import InstructionForm, { InstructionInput } from '../../FormCreator'
import { InstructionInputType } from '../../inputInstructionType'
import UseMangoV4 from '../../../../../../../../hooks/useMangoV4'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import ProgramSelector from '@components/Mango/ProgramSelector'
import useProgramSelector from '@components/Mango/useProgramSelector'

interface AltExtendForm {
  governedAccount: AssetAccount | null
  index: number
  addressLookupTable: string
  publicKeys: string
  holdupTime: number
}

const AltExtend = ({
  index,
  governance,
}: {
  index: number
  governance: ProgramAccount<Governance> | null
}) => {
  const wallet = useWalletOnePointOh()
  const programSelectorHook = useProgramSelector()

  const { mangoClient, mangoGroup } = UseMangoV4(
    programSelectorHook.program?.val,
    programSelectorHook.program?.group,
  )

  const { assetAccounts } = useGovernanceAssets()
  const solAccounts = assetAccounts.filter(
    (x) =>
      x.type === AccountType.SOL &&
      mangoGroup?.admin &&
      x.extensions.transferAddress?.equals(mangoGroup.admin),
  )
  const shouldBeGoverned = !!(index !== 0 && governance)
  const [form, setForm] = useState<AltExtendForm>({
    governedAccount: null,
    addressLookupTable: '',
    index: 0,
    publicKeys: '',
    holdupTime: 0,
  })
  const [formErrors, setFormErrors] = useState({})
  const { handleSetInstructions } = useContext(NewProposalContext)
  const validateInstruction = async (): Promise<boolean> => {
    const { isValid, validationErrors } = await isFormValid(schema, form)
    setFormErrors(validationErrors)
    return isValid
  }
  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction()
    let serializedInstruction = ''
    if (
      isValid &&
      form.governedAccount?.governance?.account &&
      wallet?.publicKey
    ) {
      const ix = await mangoClient!.program.methods
        .altExtend(Number(form.index), [
          ...form.publicKeys
            .replace(/\s/g, '')
            .split(',')
            .map((x) => new PublicKey(x)),
        ])
        .accounts({
          group: mangoGroup!.publicKey,
          admin: form.governedAccount.extensions.transferAddress,
          addressLookupTable: new PublicKey(form.addressLookupTable),
        })
        .instruction()

      serializedInstruction = serializeInstructionToBase64(ix)
    }
    const obj: UiInstruction = {
      serializedInstruction: serializedInstruction,
      isValid,
      governance: form.governedAccount?.governance,
      customHoldUpTime: form.holdupTime,
    }
    return obj
  }
  useEffect(() => {
    handleSetInstructions(
      { governedAccount: form.governedAccount?.governance, getInstruction },
      index,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- TODO please fix, it can cause difficult bugs. You might wanna check out https://bobbyhadz.com/blog/react-hooks-exhaustive-deps for info. -@asktree
  }, [form])
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Program governed account is required'),
    addressLookupTable: yup
      .string()
      .required()
      .test('is-valid-address', 'Please enter a valid PublicKey', (value) =>
        value ? validatePubkey(value) : true,
      ),
    index: yup.string().required(),
    publicKeys: yup.string().required(),
  })
  const inputs: InstructionInput[] = [
    {
      label: 'Governance',
      initialValue: form.governedAccount,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned: shouldBeGoverned as any,
      governance: governance,
      options: solAccounts,
    },
    {
      label: 'Instruction hold up time (days)',
      initialValue: form.holdupTime,
      type: InstructionInputType.INPUT,
      inputType: 'number',
      name: 'holdupTime',
    },
    {
      label: 'Address Lookup Table',
      initialValue: form.addressLookupTable,
      type: InstructionInputType.INPUT,
      name: 'addressLookupTable',
    },
    {
      label: 'Index',
      initialValue: form.index,
      type: InstructionInputType.INPUT,
      inputType: 'number',
      name: 'index',
    },
    {
      label: 'Public Keys (separated by commas)',
      initialValue: form.publicKeys,
      type: InstructionInputType.TEXTAREA,
      inputType: 'string',
      name: 'publicKeys',
    },
  ]

  return (
    <>
      <ProgramSelector
        programSelectorHook={programSelectorHook}
      ></ProgramSelector>
      {form && (
        <InstructionForm
          outerForm={form}
          setForm={setForm}
          inputs={inputs}
          setFormErrors={setFormErrors}
          formErrors={formErrors}
        ></InstructionForm>
      )}
    </>
  )
}

export default AltExtend
