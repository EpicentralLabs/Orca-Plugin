import { useContext, useEffect, useState } from 'react'
import * as yup from 'yup'
import { Governance, ProgramAccount, serializeInstructionToBase64 } from '@solana/spl-governance'
import { PublicKey } from '@solana/web3.js'
import { validateInstruction } from '@utils/instructionTools'
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes'
import { NewProposalContext } from '../../../new'
import GovernedAccountSelect from '../../GovernedAccountSelect'
import useGovernanceAssets from '@hooks/useGovernanceAssets'
import { useLegacyVoterWeight } from '@hooks/queries/governancePower'
import TokenMintInput from '@components/inputs/TokenMintInput'
import useLegacyConnectionContext from '@hooks/useLegacyConnectionContext'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import { isFormValid, validatePubkey } from '@utils/formValidation'
import Input from '@components/inputs/Input'
import { WhirlpoolContext, buildWhirlpoolClient } from '@orca-so/whirlpools-sdk'
import Decimal from 'decimal.js'

// Form interface for the component
interface OrcaCreateSplashPoolForm {
  governedAccount?: any
  tokenMintA?: string
  tokenMintB?: string
  initialPrice?: string
  whirlpoolConfig?: string
}

const OrcaCreateSplashPool = ({
  index,
  governance,
}: {
  index: number
  governance: ProgramAccount<Governance> | null
}) => {
  const connection = useLegacyConnectionContext()
  const wallet = useWalletOnePointOh()
  const { result: ownVoterWeight } = useLegacyVoterWeight()
  const { assetAccounts } = useGovernanceAssets()
  const shouldBeGoverned = !!(index !== 0 && governance)
  
  const [form, setForm] = useState<OrcaCreateSplashPoolForm>({})
  const [formErrors, setFormErrors] = useState({})
  const { handleSetInstructions } = useContext(NewProposalContext)

  const handleSetForm = ({ propertyName, value }) => {
    setFormErrors({})
    setForm({ ...form, [propertyName]: value })
  }

  // Default Orca WhirlpoolsConfig on mainnet
  const DEFAULT_WHIRLPOOLS_CONFIG = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ')
  
  // Orca Whirlpool Program ID
  const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')

  // Schema for form validation
  const schema = yup.object().shape({
    governedAccount: yup
      .object()
      .nullable()
      .required('Governed account is required'),
    tokenMintA: yup
      .string()
      .test(validatePubkey)
      .required('Token Mint A is required'),
    tokenMintB: yup
      .string()
      .test(validatePubkey)
      .required('Token Mint B is required'),
    initialPrice: yup
      .string()
      .required('Initial price is required'),
    whirlpoolConfig: yup
      .string()
      .test(validatePubkey)
      .notRequired()
  })

  async function getInstruction(): Promise<UiInstruction> {
    const { isValid, validationErrors } = await isFormValid(schema, form)
    setFormErrors(validationErrors)
    
    if (!connection || !isValid || !form.governedAccount?.governance?.account || !form.tokenMintA || !form.tokenMintB || !form.initialPrice || !wallet?.publicKey) {
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
      }
    }

    try {
      // Create a compatible wallet adapter
      const walletAdapter = {
        publicKey: wallet.publicKey,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions
      }
      
      // Create WhirlpoolContext
      const ctx = WhirlpoolContext.from(
        connection.current,
        walletAdapter,
        ORCA_WHIRLPOOL_PROGRAM_ID
      )
      
      // Build client
      const client = buildWhirlpoolClient(ctx)
      
      // Use default config if not provided
      const whirlpoolConfig = form.whirlpoolConfig 
        ? new PublicKey(form.whirlpoolConfig) 
        : DEFAULT_WHIRLPOOLS_CONFIG
      
      // Convert initialPrice to Decimal type
      const initialPrice = new Decimal(form.initialPrice)
      
      // Create splash pool transaction
      const { tx } = await client.createSplashPool(
        whirlpoolConfig, 
        new PublicKey(form.tokenMintA),
        new PublicKey(form.tokenMintB),
        initialPrice,
        form.governedAccount.governance.pubkey
      )
      
      // Get the transaction and serialize it
      const instructions = tx.build()[0].instructions
      
      return {
        serializedInstruction: serializeInstructionToBase64(instructions[0]),
        isValid: true,
        governance: form.governedAccount.governance,
      }
    } catch (error) {
      console.error('Error creating splash pool instruction:', error)
      setFormErrors({
        instruction: 'Error creating instruction: ' + (error instanceof Error ? error.message : String(error))
      })
      return {
        serializedInstruction: '',
        isValid: false,
        governance: form.governedAccount?.governance,
      }
    }
  }

  useEffect(() => {
    handleSetInstructions(
      { governedAccount: form.governedAccount?.governance, getInstruction },
      index
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- TODO please fix, it can cause difficult bugs. You might wanna check out https://bobbyhadz.com/blog/react-hooks-exhaustive-deps for info. -@asktree
  }, [form])

  return (
    <>
      <GovernedAccountSelect
        label="Governance"
        governedAccounts={assetAccounts.filter(
          (x) => ownVoterWeight?.canCreateProposal(x.governance.account.config)
        )}
        onChange={(value) => {
          handleSetForm({ value, propertyName: 'governedAccount' })
        }}
        value={form.governedAccount}
        error={formErrors['governedAccount']}
        shouldBeGoverned={shouldBeGoverned}
        governance={governance}
      />

      <TokenMintInput
        noMaxWidth={false}
        label="Token Mint A"
        onValidMintChange={(mintAddress) => {
          handleSetForm({
            value: mintAddress,
            propertyName: 'tokenMintA',
          })
        }}
      />

      <TokenMintInput
        noMaxWidth={false}
        label="Token Mint B"
        onValidMintChange={(mintAddress) => {
          handleSetForm({
            value: mintAddress,
            propertyName: 'tokenMintB',
          })
        }}
      />

      <Input
        label="Initial Price (price of Token A in terms of Token B)"
        value={form.initialPrice}
        type="number"
        min="0"
        onChange={(e) => {
          handleSetForm({
            value: e.target.value,
            propertyName: 'initialPrice',
          })
        }}
        error={formErrors['initialPrice']}
      />

      <Input
        label="Whirlpool Config (optional - defaults to devnet config)"
        value={form.whirlpoolConfig}
        type="text"
        onChange={(e) => {
          handleSetForm({
            value: e.target.value,
            propertyName: 'whirlpoolConfig',
          })
        }}
        error={formErrors['whirlpoolConfig']}
      />
      
      {formErrors['instruction'] && (
        <div className="text-red-500 text-sm mt-2">{formErrors['instruction']}</div>
      )}
    </>
  )
}

export default OrcaCreateSplashPool
