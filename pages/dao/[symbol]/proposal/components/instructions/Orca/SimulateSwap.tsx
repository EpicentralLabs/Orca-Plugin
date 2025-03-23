import { useContext, useEffect, useState } from 'react'
import * as yup from 'yup'
import {
  ProgramAccount,
  Governance,
  serializeInstructionToBase64,
} from '@solana/spl-governance'
import { validateInstruction } from '@utils/instructionTools'
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { NewProposalContext } from '../../../new'
import InstructionForm, { InstructionInput } from '../FormCreator'
import { InstructionInputType } from '../inputInstructionType'
import { AssetAccount } from '@utils/uiTypes/assets'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import { useRealmQuery } from '@hooks/queries/realm'
import useGovernanceAssets from '@hooks/useGovernanceAssets'
import { setWhirlpoolsConfig } from '@orca-so/whirlpools'
// Hypothetical function from some sub-package or client:
import { getSwapQuote } from '@orca-so/whirlpools/dist/client' // or whichever path is correct

interface SimulateSwapForm {
  governedAccount?: AssetAccount
  poolAddress: string
  tokenInMint: string
  amountIn: number
}

export default function SimulateSwap({
  index,
  governance,
}: {
  index: number
  governance: ProgramAccount<Governance> | null
}) {
  const { handleSetInstructions } = useContext(NewProposalContext)
  const realm = useRealmQuery().data?.result
  const { assetAccounts } = useGovernanceAssets()
  const wallet = useWalletOnePointOh()

  const [form, setForm] = useState<SimulateSwapForm>({
    poolAddress: '',
    tokenInMint: '',
    amountIn: 0,
  })
  const [formErrors, setFormErrors] = useState({})
  const [swapQuote, setSwapQuote] = useState<any>(null)

  const shouldBeGoverned = !!(index !== 0 && governance)

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account is required'),
    poolAddress: yup.string().required('Pool address is required'),
    tokenInMint: yup.string().required('Token In mint required'),
    amountIn: yup.number().positive().required('Amount in must be > 0'),
  })

  // This is off-chain, so we return a no-op instruction again.
  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors })
    let serializedInstruction = ''

    if (isValid && form.governedAccount?.governance?.account && wallet?.publicKey) {
      await setWhirlpoolsConfig('solanaDevnet')
      // Example usage if the advanced client has getSwapQuote
      try {
        const quote = await getSwapQuote({
          whirlpool: new PublicKey(form.poolAddress),
          tokenInMint: new PublicKey(form.tokenInMint),
          amountIn: BigInt(form.amountIn),
        })
        setSwapQuote(quote)
      } catch (e) {
        console.error('Failed to simulate swap', e)
      }

      // Create a no-op instruction
      const ix = new TransactionInstruction({
        keys: [],
        programId: new PublicKey('11111111111111111111111111111111'),
        data: Buffer.alloc(0),
      })
      serializedInstruction = serializeInstructionToBase64(ix)
    }

    return {
      serializedInstruction,
      isValid,
      governance: form.governedAccount?.governance,
    }
  }

  const inputs: InstructionInput[] = [
    {
      label: 'Governance',
      initialValue: null,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts,
    },
    {
      label: 'Pool Address',
      initialValue: '',
      name: 'poolAddress',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token In Mint',
      initialValue: '',
      name: 'tokenInMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Amount In',
      initialValue: 0,
      name: 'amountIn',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
  ]

  useEffect(() => {
    handleSetInstructions(
      {
        governedAccount: form.governedAccount?.governance,
        getInstruction,
      },
      index
    )
  }, [form])

  return (
    <div>
      <InstructionForm
        outerForm={form}
        setForm={setForm}
        inputs={inputs}
        setFormErrors={setFormErrors}
        formErrors={formErrors}
      />
      {swapQuote && (
        <pre className="mt-2 p-2 border border-fgd-4 rounded bg-bkg-1">
          {JSON.stringify(swapQuote, null, 2)}
        </pre>
      )}
    </div>
  )
}
